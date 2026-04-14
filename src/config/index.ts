import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ContextSwitchConfig } from '../types.js';

const APP_DIR = path.join(os.homedir(), '.context-switch');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const SNAPSHOTS_DIR = path.join(APP_DIR, 'snapshots');
const DAEMON_PID_FILE = path.join(APP_DIR, 'daemon.pid');
const DAEMON_LOG_FILE = path.join(APP_DIR, 'daemon.log');

export const paths = {
  appDir: APP_DIR,
  configFile: CONFIG_FILE,
  snapshotsDir: SNAPSHOTS_DIR,
  daemonPidFile: DAEMON_PID_FILE,
  daemonLogFile: DAEMON_LOG_FILE,

  snapshotDir(directory: string): string {
    const hash = Buffer.from(directory).toString('base64url');
    return path.join(SNAPSHOTS_DIR, hash);
  },
} as const;

const DEFAULT_CONFIG: ContextSwitchConfig = {
  watchDirectories: [],
  snapshotIntervalMs: 5 * 60 * 1000, // 5 minutes
  maxSnapshots: 200,
  retentionHours: 72, // 3 days
  filePatterns: {
    include: [
      '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
      '**/*.py', '**/*.rb', '**/*.go', '**/*.rs',
      '**/*.java', '**/*.kt', '**/*.swift', '**/*.c', '**/*.cpp', '**/*.h',
      '**/*.css', '**/*.scss', '**/*.html', '**/*.vue', '**/*.svelte',
      '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml',
      '**/*.md', '**/*.txt',
      '**/*.sql', '**/*.sh', '**/*.zsh', '**/*.bash',
      '**/*.dockerfile', '**/Dockerfile', '**/Makefile',
    ],
    exclude: [
      '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**',
      '**/vendor/**', '**/__pycache__/**', '**/target/**',
      '**/.next/**', '**/.nuxt/**', '**/coverage/**',
      '**/*.min.js', '**/*.min.css', '**/*.map',
      '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml',
    ],
  },
  recentFileMinutes: 120, // 2 hours
  gitCommitDepth: 15,
  shellHistoryLines: 30,
};

export function ensureAppDir(): void {
  fs.mkdirSync(paths.appDir, { recursive: true });
  fs.mkdirSync(paths.snapshotsDir, { recursive: true });
}

export function loadConfig(): ContextSwitchConfig {
  ensureAppDir();

  if (!fs.existsSync(paths.configFile)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(paths.configFile, 'utf-8');
    const userConfig = JSON.parse(raw) as Partial<ContextSwitchConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      filePatterns: {
        ...DEFAULT_CONFIG.filePatterns,
        ...(userConfig.filePatterns ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: ContextSwitchConfig): void {
  ensureAppDir();
  fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function getLanguageFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript/React',
    '.js': 'JavaScript', '.jsx': 'JavaScript/React',
    '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
    '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift',
    '.c': 'C', '.cpp': 'C++', '.h': 'C/C++ Header',
    '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML',
    '.vue': 'Vue', '.svelte': 'Svelte',
    '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
    '.md': 'Markdown', '.sql': 'SQL',
    '.sh': 'Shell', '.zsh': 'Zsh', '.bash': 'Bash',
    '.dockerfile': 'Docker',
  };
  return map[ext] ?? null;
}
