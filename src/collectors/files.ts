import fs from 'node:fs';
import path from 'node:path';
import type { FileContext, RecentFile } from '../types.js';
import type { ContextSwitchConfig } from '../types.js';
import { getLanguageFromPath } from '../config/index.js';

/**
 * Recursively find files modified within a given time window,
 * respecting include/exclude patterns from config.
 */
export async function collectFileContext(
  cwd: string,
  config: ContextSwitchConfig,
): Promise<FileContext> {
  const cutoff = Date.now() - config.recentFileMinutes * 60 * 1000;
  const recentlyModified: RecentFile[] = [];

  const excludeDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__',
    'vendor', 'target', '.next', '.nuxt', 'coverage',
    '.cache', '.parcel-cache', '.turbo', '.vercel', '.output',
  ]);

  const excludeFiles = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  ]);

  const includeExtensions = new Set(
    config.filePatterns.include
      .map((p) => {
        const match = p.match(/\*(\.\w+)$/);
        return match ? match[1] : null;
      })
      .filter((e): e is string => e !== null),
  );

  function walk(dir: string, depth: number): void {
    if (depth > 8) return; // Prevent deep recursion

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or deleted mid-walk
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        if (excludeDirs.has(entry.name)) continue;
        walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (excludeFiles.has(entry.name)) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (includeExtensions.size > 0 && !includeExtensions.has(ext)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.mtimeMs < cutoff) continue;

      recentlyModified.push({
        path: fullPath,
        relativePath: path.relative(cwd, fullPath),
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        sizeBytes: stat.size,
        language: getLanguageFromPath(fullPath),
      });
    }
  }

  walk(cwd, 0);

  // Sort by most recently modified first
  recentlyModified.sort(
    (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
  );

  // Cap at 50 most recent files
  return {
    recentlyModified: recentlyModified.slice(0, 50),
  };
}
