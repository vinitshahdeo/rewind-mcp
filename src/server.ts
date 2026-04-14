import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { collectSnapshot } from './collectors/index.js';
import { generateRecoveryReport, formatReportAsText } from './recovery/engine.js';
import {
  saveSnapshot,
  loadSnapshots,
  getLatestSnapshot,
  applyRetention,
  listTrackedDirectories,
  getTotalSnapshotCount,
} from './storage/store.js';
import { loadConfig } from './config/index.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'context-switch',
    version: '1.0.0',
  });

  // ─── Tool: where_was_i ──────────────────────────────────────────────────────
  server.tool(
    'where_was_i',
    `Reconstructs your working context after an interruption. Analyzes git state (branch, uncommitted changes, recent commits, stashes, merge state), recently modified files, editor state, and shell history to tell you:
- What you were working on and why (with confidence levels)
- What's in progress (uncommitted work, open branches, merge conflicts)
- Suggested next steps prioritized by urgency
- A timeline of recent activity

Use this when you return from a meeting, break, or context switch and need to reload your mental state. Pass the project directory to analyze.`,
    {
      directory: z.string().describe('Absolute path to the project directory to analyze'),
    },
    async ({ directory }) => {
      const config = loadConfig();
      const previous = getLatestSnapshot(directory);
      const current = await collectSnapshot(directory, config, 'manual');

      // Save this snapshot for future comparisons
      saveSnapshot(current);

      // Apply retention
      applyRetention(directory, config.retentionHours, config.maxSnapshots);

      const report = generateRecoveryReport(current, previous);
      const text = formatReportAsText(report);

      return {
        content: [{ type: 'text', text }],
      };
    },
  );

  // ─── Tool: take_snapshot ────────────────────────────────────────────────────
  server.tool(
    'take_snapshot',
    `Takes a point-in-time snapshot of your current working context. Captures git state, recently modified files, editor state, and shell history. Use this before stepping away from your work (meetings, breaks, end of day) so that 'where_was_i' can compare your previous state with the current state when you return.`,
    {
      directory: z.string().describe('Absolute path to the project directory to snapshot'),
    },
    async ({ directory }) => {
      const config = loadConfig();
      const snapshot = await collectSnapshot(directory, config, 'manual');
      const filePath = saveSnapshot(snapshot);

      // Apply retention
      applyRetention(directory, config.retentionHours, config.maxSnapshots);

      const uncommitted = snapshot.git.status.filter((f) => f.status !== 'untracked').length;
      const recentFiles = snapshot.files.recentlyModified.length;
      const branch = snapshot.git.isRepo ? snapshot.git.branch : 'N/A';

      return {
        content: [{
          type: 'text',
          text: [
            '# Snapshot Saved',
            '',
            `**ID:** \`${snapshot.id.slice(0, 8)}\``,
            `**Time:** ${new Date(snapshot.timestamp).toLocaleString()}`,
            `**Directory:** ${directory}`,
            `**Branch:** \`${branch}\``,
            `**Uncommitted changes:** ${uncommitted}`,
            `**Recently modified files:** ${recentFiles}`,
            `**Shell commands captured:** ${snapshot.shell.recentCommands.length}`,
            '',
            `Snapshot stored at: \`${filePath}\``,
            '',
            'When you return, use `where_was_i` to see what changed.',
          ].join('\n'),
        }],
      };
    },
  );

  // ─── Tool: recent_activity ──────────────────────────────────────────────────
  server.tool(
    'recent_activity',
    `Shows a timeline of recent development activity in a project directory. Combines git commits, file modifications, and shell commands into a chronological view. Useful for understanding what happened in a project over a time period, or for reviewing your own recent work.`,
    {
      directory: z.string().describe('Absolute path to the project directory'),
      hours: z.number().optional().default(4).describe('How many hours back to look (default: 4)'),
    },
    async ({ directory, hours }) => {
      const config = loadConfig();
      const modifiedConfig = { ...config, recentFileMinutes: hours * 60 };
      const snapshot = await collectSnapshot(directory, modifiedConfig, 'auto');

      // Build a combined timeline
      const entries: Array<{ time: Date; icon: string; text: string }> = [];
      const cutoff = Date.now() - hours * 60 * 60 * 1000;

      for (const commit of snapshot.git.recentCommits) {
        const commitTime = new Date(commit.date);
        if (commitTime.getTime() >= cutoff) {
          entries.push({
            time: commitTime,
            icon: '📝',
            text: `**Commit** \`${commit.shortHash}\`: ${commit.message} (${commit.filesChanged} files)`,
          });
        }
      }

      for (const file of snapshot.files.recentlyModified) {
        const modTime = new Date(file.modifiedAt);
        if (modTime.getTime() >= cutoff) {
          entries.push({
            time: modTime,
            icon: '📄',
            text: `**Modified** \`${file.relativePath}\`${file.language ? ` (${file.language})` : ''}`,
          });
        }
      }

      for (const cmd of snapshot.shell.recentCommands) {
        if (cmd.timestamp) {
          const cmdTime = new Date(cmd.timestamp);
          if (cmdTime.getTime() >= cutoff) {
            entries.push({
              time: cmdTime,
              icon: '⌨️',
              text: `**Command** \`${cmd.command}\``,
            });
          }
        }
      }

      entries.sort((a, b) => b.time.getTime() - a.time.getTime());

      const lines: string[] = [];
      lines.push(`# Recent Activity (last ${hours} hours)`);
      lines.push('');
      lines.push(`**Directory:** ${directory}`);
      if (snapshot.git.isRepo) {
        lines.push(`**Branch:** \`${snapshot.git.branch}\``);
      }
      lines.push(`**Events:** ${entries.length}`);
      lines.push('');

      if (entries.length === 0) {
        lines.push('No recent activity found in this time window.');
      } else {
        let lastDate = '';
        for (const entry of entries.slice(0, 40)) {
          const dateStr = entry.time.toLocaleDateString();
          if (dateStr !== lastDate) {
            lines.push(`### ${dateStr}`);
            lastDate = dateStr;
          }
          const timeStr = entry.time.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          });
          lines.push(`${entry.icon} \`${timeStr}\` ${entry.text}`);
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  // ─── Tool: get_context_status ───────────────────────────────────────────────
  server.tool(
    'get_context_status',
    `Shows the current status of the Context Switch agent: tracked directories, snapshot counts, and storage info. Useful for understanding what the agent knows about and managing its state.`,
    {},
    async () => {
      const directories = listTrackedDirectories();
      const totalSnapshots = getTotalSnapshotCount();

      const lines: string[] = [];
      lines.push('# Context Switch Status');
      lines.push('');
      lines.push(`**Total snapshots:** ${totalSnapshots}`);
      lines.push(`**Tracked directories:** ${directories.length}`);
      lines.push('');

      if (directories.length === 0) {
        lines.push('No directories tracked yet. Use `take_snapshot` or `where_was_i` to start tracking.');
      } else {
        lines.push('## Tracked Directories');
        lines.push('');
        for (const dir of directories) {
          const snapshots = loadSnapshots(dir, 1);
          const latest = snapshots[0];
          const lastTime = latest
            ? new Date(latest.timestamp).toLocaleString()
            : 'unknown';
          const count = loadSnapshots(dir).length;
          lines.push(`- **${dir}** — ${count} snapshot${count !== 1 ? 's' : ''}, last: ${lastTime}`);
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  // ─── Tool: diff_snapshots ──────────────────────────────────────────────────
  server.tool(
    'diff_snapshots',
    `Compares two snapshots (or the latest snapshot vs current state) to show what changed between them. Useful for understanding what happened while you were away, or for reviewing changes between any two points in time.`,
    {
      directory: z.string().describe('Absolute path to the project directory'),
      snapshotIndex: z.number().optional().default(0).describe('Index of the older snapshot to compare against (0 = most recent, 1 = second most recent, etc.)'),
    },
    async ({ directory, snapshotIndex }) => {
      const config = loadConfig();
      const snapshots = loadSnapshots(directory, snapshotIndex + 2);

      if (snapshots.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No snapshots found for ${directory}. Use \`take_snapshot\` first.`,
          }],
        };
      }

      const olderSnapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
      const current = await collectSnapshot(directory, config, 'auto');

      const lines: string[] = [];
      lines.push('# Snapshot Diff');
      lines.push('');
      lines.push(`**Comparing:** ${new Date(olderSnapshot.timestamp).toLocaleString()} → Now`);
      lines.push(`**Directory:** ${directory}`);
      lines.push('');

      // Branch changes
      if (olderSnapshot.git.branch !== current.git.branch) {
        lines.push(`**Branch changed:** \`${olderSnapshot.git.branch}\` → \`${current.git.branch}\``);
      } else {
        lines.push(`**Branch:** \`${current.git.branch}\``);
      }
      lines.push('');

      // New commits since snapshot
      const snapshotCommitHashes = new Set(olderSnapshot.git.recentCommits.map((c) => c.hash));
      const newCommits = current.git.recentCommits.filter((c) => !snapshotCommitHashes.has(c.hash));

      if (newCommits.length > 0) {
        lines.push(`## New Commits (${newCommits.length})`);
        lines.push('');
        for (const commit of newCommits) {
          lines.push(`- \`${commit.shortHash}\` ${commit.message} — ${commit.author}`);
        }
        lines.push('');
      }

      // File status changes
      const oldFiles = new Set(olderSnapshot.git.status.map((f) => f.file));
      const currentFiles = new Set(current.git.status.map((f) => f.file));

      const newlyChanged = current.git.status.filter((f) => !oldFiles.has(f.file));
      const resolved = olderSnapshot.git.status.filter((f) => !currentFiles.has(f.file));

      if (newlyChanged.length > 0) {
        lines.push(`## Newly Changed Files (${newlyChanged.length})`);
        lines.push('');
        for (const f of newlyChanged) {
          lines.push(`- \`${f.file}\` (${f.status}${f.staged ? ', staged' : ''})`);
        }
        lines.push('');
      }

      if (resolved.length > 0) {
        lines.push(`## Resolved Since Last Snapshot (${resolved.length})`);
        lines.push('');
        for (const f of resolved) {
          lines.push(`- \`${f.file}\` was ${f.status}, now clean`);
        }
        lines.push('');
      }

      // Stash changes
      if (current.git.stashes.length !== olderSnapshot.git.stashes.length) {
        const diff = current.git.stashes.length - olderSnapshot.git.stashes.length;
        if (diff > 0) {
          lines.push(`**Stash:** ${diff} new stash${diff !== 1 ? 'es' : ''} added`);
        } else {
          lines.push(`**Stash:** ${Math.abs(diff)} stash${Math.abs(diff) !== 1 ? 'es' : ''} popped/dropped`);
        }
        lines.push('');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    },
  );

  return server;
}
