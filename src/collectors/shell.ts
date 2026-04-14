import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ShellContext, ShellCommand } from '../types.js';

/**
 * Collect recent shell history from the user's configured shell.
 */
export async function collectShellContext(
  maxLines: number,
): Promise<ShellContext> {
  const shell = detectShell();
  const historyFile = getHistoryFile(shell);
  const recentCommands = readHistory(historyFile, shell, maxLines);

  return {
    shell,
    recentCommands,
  };
}

function detectShell(): string {
  return process.env.SHELL
    ? path.basename(process.env.SHELL)
    : 'unknown';
}

function getHistoryFile(shell: string): string | null {
  // Respect HISTFILE environment variable first
  if (process.env.HISTFILE) {
    return process.env.HISTFILE;
  }

  const home = os.homedir();

  switch (shell) {
    case 'zsh':
      return path.join(home, '.zsh_history');
    case 'bash':
      return path.join(home, '.bash_history');
    case 'fish':
      return path.join(home, '.local/share/fish/fish_history');
    default:
      // Try common locations
      for (const candidate of ['.zsh_history', '.bash_history']) {
        const p = path.join(home, candidate);
        if (fs.existsSync(p)) return p;
      }
      return null;
  }
}

function readHistory(
  historyFile: string | null,
  shell: string,
  maxLines: number,
): ShellCommand[] {
  if (!historyFile || !fs.existsSync(historyFile)) return [];

  try {
    const content = fs.readFileSync(historyFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    // Take the last N lines
    const recent = lines.slice(-maxLines * 2); // Take extra to account for multi-line entries

    if (shell === 'zsh') {
      return parseZshHistory(recent, maxLines);
    } else if (shell === 'fish') {
      return parseFishHistory(recent, maxLines);
    } else {
      return parseBashHistory(recent, maxLines);
    }
  } catch {
    return [];
  }
}

/**
 * Zsh history format: `: <timestamp>:0;<command>`
 */
function parseZshHistory(lines: string[], maxLines: number): ShellCommand[] {
  const commands: ShellCommand[] = [];

  for (const line of lines) {
    const match = line.match(/^: (\d+):\d+;(.+)$/);
    if (match) {
      commands.push({
        command: match[2].trim(),
        timestamp: new Date(parseInt(match[1], 10) * 1000).toISOString(),
      });
    } else if (!line.startsWith(':') && line.trim()) {
      // Plain format (no timestamps)
      commands.push({
        command: line.trim(),
        timestamp: null,
      });
    }
  }

  return deduplicateAndFilter(commands, maxLines);
}

/**
 * Bash history: plain commands, one per line, no timestamps by default.
 */
function parseBashHistory(lines: string[], maxLines: number): ShellCommand[] {
  const commands: ShellCommand[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    commands.push({
      command: trimmed,
      timestamp: null,
    });
  }

  return deduplicateAndFilter(commands, maxLines);
}

/**
 * Fish history format:
 * ```
 * - cmd: <command>
 *   when: <timestamp>
 * ```
 */
function parseFishHistory(lines: string[], maxLines: number): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let currentCmd: string | null = null;

  for (const line of lines) {
    const cmdMatch = line.match(/^- cmd: (.+)$/);
    const whenMatch = line.match(/^\s+when: (\d+)$/);

    if (cmdMatch) {
      if (currentCmd) {
        commands.push({ command: currentCmd, timestamp: null });
      }
      currentCmd = cmdMatch[1].trim();
    } else if (whenMatch && currentCmd) {
      commands.push({
        command: currentCmd,
        timestamp: new Date(parseInt(whenMatch[1], 10) * 1000).toISOString(),
      });
      currentCmd = null;
    }
  }

  if (currentCmd) {
    commands.push({ command: currentCmd, timestamp: null });
  }

  return deduplicateAndFilter(commands, maxLines);
}

/**
 * Filter out noise commands and deduplicate consecutive duplicates.
 */
function deduplicateAndFilter(
  commands: ShellCommand[],
  maxLines: number,
): ShellCommand[] {
  const noise = new Set([
    'ls', 'll', 'la', 'l', 'cd', 'pwd', 'clear', 'cls', 'exit',
    'history', 'which', 'whoami', 'date', 'cal',
  ]);

  const filtered = commands.filter((cmd) => {
    const base = cmd.command.split(/\s+/)[0];
    return !noise.has(base);
  });

  // Remove consecutive duplicates
  const deduped: ShellCommand[] = [];
  for (const cmd of filtered) {
    if (deduped.length === 0 || deduped[deduped.length - 1].command !== cmd.command) {
      deduped.push(cmd);
    }
  }

  return deduped.slice(-maxLines);
}
