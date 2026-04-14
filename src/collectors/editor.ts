import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EditorContext } from '../types.js';

const exec = promisify(execFile);

const EMPTY_EDITOR_CONTEXT: EditorContext = {
  detected: false,
  type: 'unknown',
  openFiles: [],
  workspaceFolder: null,
  recentlyOpenedPaths: [],
};

/**
 * Detect VS Code open workspaces by inspecting its storage database.
 * This reads the VS Code state DB which tracks recently opened windows/files.
 */
async function detectVSCode(cwd: string): Promise<EditorContext | null> {
  // VS Code stores its state in different locations per OS
  const home = os.homedir();
  const platform = os.platform();

  let storagePaths: string[];
  if (platform === 'darwin') {
    storagePaths = [
      path.join(home, 'Library/Application Support/Code/storage.json'),
      path.join(home, 'Library/Application Support/Code/User/globalStorage/storage.json'),
    ];
  } else if (platform === 'linux') {
    storagePaths = [
      path.join(home, '.config/Code/storage.json'),
    ];
  } else {
    storagePaths = [
      path.join(home, 'AppData/Roaming/Code/storage.json'),
    ];
  }

  // Also check for Cursor editor (VS Code fork)
  if (platform === 'darwin') {
    storagePaths.push(
      path.join(home, 'Library/Application Support/Cursor/User/globalStorage/storage.json'),
    );
  }

  // Try to read VS Code's recently opened workspaces
  for (const storagePath of storagePaths) {
    try {
      if (!fs.existsSync(storagePath)) continue;
      const raw = fs.readFileSync(storagePath, 'utf-8');
      const data = JSON.parse(raw);

      const recentlyOpened: string[] = [];
      const openedPathsList = data?.openedPathsList?.entries ?? data?.openedPathsList?.workspaces3 ?? [];

      for (const entry of openedPathsList) {
        const uri = typeof entry === 'string' ? entry : entry?.folderUri ?? entry?.workspace?.configPath ?? '';
        if (uri) {
          const cleaned = uri.replace('file://', '');
          recentlyOpened.push(decodeURIComponent(cleaned));
        }
      }

      const isCursor = storagePath.includes('Cursor');
      const isWorkspaceOpen = recentlyOpened.some(
        (p) => cwd.startsWith(p) || p.startsWith(cwd),
      );

      if (isWorkspaceOpen || recentlyOpened.length > 0) {
        return {
          detected: true,
          type: isCursor ? 'cursor' : 'vscode',
          openFiles: await getVSCodeOpenTabs(cwd),
          workspaceFolder: isWorkspaceOpen ? cwd : null,
          recentlyOpenedPaths: recentlyOpened.slice(0, 10),
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Try to get open tabs from VS Code by reading the workspace backup metadata.
 */
async function getVSCodeOpenTabs(cwd: string): Promise<string[]> {
  const home = os.homedir();
  const platform = os.platform();

  let backupsDir: string;
  if (platform === 'darwin') {
    backupsDir = path.join(home, 'Library/Application Support/Code/Backups');
  } else if (platform === 'linux') {
    backupsDir = path.join(home, '.config/Code/Backups');
  } else {
    backupsDir = path.join(home, 'AppData/Roaming/Code/Backups');
  }

  // Also check User/workspaceStorage for open editors
  let workspaceStorageDir: string;
  if (platform === 'darwin') {
    workspaceStorageDir = path.join(home, 'Library/Application Support/Code/User/workspaceStorage');
  } else if (platform === 'linux') {
    workspaceStorageDir = path.join(home, '.config/Code/User/workspaceStorage');
  } else {
    workspaceStorageDir = path.join(home, 'AppData/Roaming/Code/User/workspaceStorage');
  }

  const openFiles: string[] = [];

  try {
    if (!fs.existsSync(workspaceStorageDir)) return openFiles;

    const workspaces = fs.readdirSync(workspaceStorageDir);
    for (const ws of workspaces) {
      const wsJson = path.join(workspaceStorageDir, ws, 'workspace.json');
      try {
        if (!fs.existsSync(wsJson)) continue;
        const data = JSON.parse(fs.readFileSync(wsJson, 'utf-8'));
        const folder = data?.folder;
        if (!folder) continue;

        const decodedFolder = decodeURIComponent(folder.replace('file://', ''));
        if (!decodedFolder.startsWith(cwd) && !cwd.startsWith(decodedFolder)) continue;

        // Found the workspace — try to read its state DB for open editors
        const stateDb = path.join(workspaceStorageDir, ws, 'state.vscdb');
        if (fs.existsSync(stateDb)) {
          // state.vscdb is a SQLite DB — we can't read it without a dependency.
          // Instead, look for backup files as a proxy for open files.
          const backupDir = path.join(backupsDir, ws);
          if (fs.existsSync(backupDir)) {
            const entries = fs.readdirSync(backupDir, { recursive: true }) as string[];
            for (const entry of entries) {
              if (typeof entry === 'string' && entry.endsWith('.json')) {
                openFiles.push(entry);
              }
            }
          }
        }
        break;
      } catch {
        continue;
      }
    }
  } catch {
    // Not available
  }

  return openFiles;
}

/**
 * Detect JetBrains IDE by checking for .idea directory and recent project state.
 */
async function detectJetBrains(cwd: string): Promise<EditorContext | null> {
  const ideaDir = path.join(cwd, '.idea');
  if (!fs.existsSync(ideaDir)) return null;

  const openFiles: string[] = [];

  // Try to read workspace.xml for open editor tabs
  const workspaceXml = path.join(ideaDir, 'workspace.xml');
  if (fs.existsSync(workspaceXml)) {
    try {
      const content = fs.readFileSync(workspaceXml, 'utf-8');
      // Simple regex extraction of file URLs from workspace XML
      const fileRefs = content.matchAll(/file:\/\/\$PROJECT_DIR\$\/([^"<]+)/g);
      for (const match of fileRefs) {
        openFiles.push(decodeURIComponent(match[1]));
      }
    } catch {
      // Not readable
    }
  }

  return {
    detected: true,
    type: 'jetbrains',
    openFiles: [...new Set(openFiles)].slice(0, 30),
    workspaceFolder: cwd,
    recentlyOpenedPaths: [],
  };
}

/**
 * Detect Vim/Neovim by checking for swap files in the project.
 */
async function detectVim(cwd: string): Promise<string[]> {
  const swapFiles: string[] = [];
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('.swp')) {
        // .filename.swp → filename
        const original = entry.name.slice(1, -4);
        swapFiles.push(original);
      }
    }
  } catch {
    // Not available
  }
  return swapFiles;
}

/**
 * Collect editor context by trying multiple detection strategies.
 */
export async function collectEditorContext(cwd: string): Promise<EditorContext> {
  // Check for running editor processes
  let runningEditors: string[] = [];
  try {
    const { stdout } = await exec('ps', ['aux'], { timeout: 5000 });
    if (stdout.includes('code') || stdout.includes('Code')) {
      runningEditors.push('vscode');
    }
    if (stdout.includes('cursor') || stdout.includes('Cursor')) {
      runningEditors.push('cursor');
    }
    if (stdout.includes('idea') || stdout.includes('webstorm') || stdout.includes('pycharm')) {
      runningEditors.push('jetbrains');
    }
  } catch {
    // Process listing not available
  }

  // Try VS Code / Cursor detection
  const vscode = await detectVSCode(cwd);
  if (vscode) return vscode;

  // Try JetBrains detection
  const jetbrains = await detectJetBrains(cwd);
  if (jetbrains) return jetbrains;

  // Check for Vim swap files
  const vimFiles = await detectVim(cwd);
  if (vimFiles.length > 0) {
    return {
      detected: true,
      type: 'unknown',
      openFiles: vimFiles,
      workspaceFolder: cwd,
      recentlyOpenedPaths: [],
    };
  }

  return { ...EMPTY_EDITOR_CONTEXT };
}
