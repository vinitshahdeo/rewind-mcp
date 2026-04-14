import fs from 'node:fs';
import path from 'node:path';
import type { ContextSnapshot } from '../types.js';
import { paths, ensureAppDir } from '../config/index.js';

/**
 * Save a snapshot to disk, organized by project directory.
 */
export function saveSnapshot(snapshot: ContextSnapshot): string {
  ensureAppDir();
  const dir = paths.snapshotDir(snapshot.directory);
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${snapshot.timestamp.replace(/[:.]/g, '-')}_${snapshot.id.slice(0, 8)}.json`;
  const filePath = path.join(dir, filename);

  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return filePath;
}

/**
 * Load snapshots for a given directory, sorted newest first.
 */
export function loadSnapshots(
  directory: string,
  limit?: number,
): ContextSnapshot[] {
  const dir = paths.snapshotDir(directory);
  if (!fs.existsSync(dir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse(); // newest first by filename (ISO timestamp)
  } catch {
    return [];
  }

  if (limit) {
    files = files.slice(0, limit);
  }

  const snapshots: ContextSnapshot[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      snapshots.push(JSON.parse(raw));
    } catch {
      // Skip corrupt snapshots
      continue;
    }
  }

  return snapshots;
}

/**
 * Get the most recent snapshot for a directory.
 */
export function getLatestSnapshot(directory: string): ContextSnapshot | null {
  const snapshots = loadSnapshots(directory, 1);
  return snapshots[0] ?? null;
}

/**
 * Apply retention policy: remove snapshots older than retentionHours
 * and cap at maxSnapshots per directory.
 */
export function applyRetention(
  directory: string,
  retentionHours: number,
  maxSnapshots: number,
): { deleted: number } {
  const dir = paths.snapshotDir(directory);
  if (!fs.existsSync(dir)) return { deleted: 0 };

  let files: string[];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort(); // oldest first
  } catch {
    return { deleted: 0 };
  }

  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  let deleted = 0;

  // Delete files older than retention period
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch {
      continue;
    }
  }

  // Re-read and enforce max count
  try {
    const remaining = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort(); // oldest first

    const excess = remaining.length - maxSnapshots;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        fs.unlinkSync(path.join(dir, remaining[i]));
        deleted++;
      }
    }
  } catch {
    // Best effort
  }

  return { deleted };
}

/**
 * List all tracked project directories.
 */
export function listTrackedDirectories(): string[] {
  if (!fs.existsSync(paths.snapshotsDir)) return [];

  try {
    return fs.readdirSync(paths.snapshotsDir)
      .map((hash) => {
        try {
          return Buffer.from(hash, 'base64url').toString('utf-8');
        } catch {
          return null;
        }
      })
      .filter((d): d is string => d !== null);
  } catch {
    return [];
  }
}

/**
 * Get total snapshot count across all directories.
 */
export function getTotalSnapshotCount(): number {
  if (!fs.existsSync(paths.snapshotsDir)) return 0;

  let count = 0;
  try {
    const dirs = fs.readdirSync(paths.snapshotsDir);
    for (const dir of dirs) {
      const dirPath = path.join(paths.snapshotsDir, dir);
      try {
        const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
        count += files.length;
      } catch {
        continue;
      }
    }
  } catch {
    // Not available
  }

  return count;
}
