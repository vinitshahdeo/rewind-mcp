import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type {
  GitContext,
  GitFileStatus,
  GitCommit,
  GitStash,
  MergeState,
  DiffSummary,
} from '../types.js';

const exec = promisify(execFile);

const EMPTY_GIT_CONTEXT: GitContext = {
  isRepo: false,
  branch: '',
  upstream: null,
  status: [],
  recentCommits: [],
  stashes: [],
  mergeState: null,
  diff: null,
};

async function git(
  args: string[],
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return result === 'true';
}

async function getBranch(cwd: string): Promise<string> {
  const branch = await git(['symbolic-ref', '--short', 'HEAD'], cwd);
  if (branch) return branch;

  // Detached HEAD — return short hash
  const hash = await git(['rev-parse', '--short', 'HEAD'], cwd);
  return hash ? `(detached ${hash})` : '(unknown)';
}

async function getUpstream(cwd: string): Promise<string | null> {
  const upstream = await git(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    cwd,
  );
  return upstream || null;
}

async function getStatus(cwd: string): Promise<GitFileStatus[]> {
  const raw = await git(['status', '--porcelain=v1', '-uall'], cwd);
  if (!raw) return [];

  return raw.split('\n').filter(Boolean).map((line) => {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const file = line.slice(3).trim();

    // Determine if staged
    const staged = indexStatus !== ' ' && indexStatus !== '?';

    // Map status codes
    let status: GitFileStatus['status'];
    const effectiveStatus = staged ? indexStatus : workTreeStatus;

    switch (effectiveStatus) {
      case 'M': status = 'modified'; break;
      case 'A': status = 'added'; break;
      case 'D': status = 'deleted'; break;
      case 'R': status = 'renamed'; break;
      case 'U': status = 'conflicted'; break;
      case '?': status = 'untracked'; break;
      default: status = 'modified';
    }

    return { file, status, staged };
  });
}

async function getRecentCommits(
  cwd: string,
  depth: number,
): Promise<GitCommit[]> {
  const format = '%H%x00%h%x00%s%x00%an%x00%aI%x00';
  const raw = await git(
    ['log', `--max-count=${depth}`, `--pretty=format:${format}`, '--shortstat'],
    cwd,
  );
  if (!raw) return [];

  const commits: GitCommit[] = [];
  const lines = raw.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || !line.includes('\0')) {
      i++;
      continue;
    }

    const parts = line.split('\0');
    if (parts.length < 5) {
      i++;
      continue;
    }

    // Look for the shortstat line (next non-empty line)
    let filesChanged = 0;
    if (i + 1 < lines.length) {
      const statLine = lines[i + 1];
      const match = statLine.match(/(\d+) files? changed/);
      if (match) {
        filesChanged = parseInt(match[1], 10);
        i++; // skip the stat line
      }
    }

    commits.push({
      hash: parts[0],
      shortHash: parts[1],
      message: parts[2],
      author: parts[3],
      date: parts[4],
      filesChanged,
    });

    i++;
  }

  return commits;
}

async function getStashes(cwd: string): Promise<GitStash[]> {
  const raw = await git(
    ['stash', 'list', '--pretty=format:%gd%x00%gs%x00%aI'],
    cwd,
  );
  if (!raw) return [];

  return raw.split('\n').filter(Boolean).map((line) => {
    const [ref, message, date] = line.split('\0');
    const indexMatch = ref.match(/\{(\d+)\}/);
    return {
      index: indexMatch ? parseInt(indexMatch[1], 10) : 0,
      message: message || ref,
      date: date || '',
    };
  });
}

async function getMergeState(cwd: string): Promise<MergeState | null> {
  const gitDir = await git(['rev-parse', '--git-dir'], cwd);
  if (!gitDir) return null;

  const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);

  // Check for merge in progress
  if (fs.existsSync(path.join(absGitDir, 'MERGE_HEAD'))) {
    const mergeMsg = await git(['log', '-1', '--pretty=%s', 'MERGE_HEAD'], cwd);
    return { type: 'merge', branch: mergeMsg || undefined };
  }

  // Check for rebase in progress
  const rebaseDir = fs.existsSync(path.join(absGitDir, 'rebase-merge'))
    ? path.join(absGitDir, 'rebase-merge')
    : fs.existsSync(path.join(absGitDir, 'rebase-apply'))
      ? path.join(absGitDir, 'rebase-apply')
      : null;

  if (rebaseDir) {
    let progress: string | undefined;
    try {
      const step = fs.readFileSync(path.join(rebaseDir, 'msgnum'), 'utf-8').trim();
      const total = fs.readFileSync(path.join(rebaseDir, 'end'), 'utf-8').trim();
      progress = `${step}/${total}`;
    } catch { /* not available */ }
    return { type: 'rebase', progress };
  }

  // Check for cherry-pick in progress
  if (fs.existsSync(path.join(absGitDir, 'CHERRY_PICK_HEAD'))) {
    return { type: 'cherry-pick' };
  }

  return null;
}

async function getDiffSummary(cwd: string): Promise<DiffSummary | null> {
  const raw = await git(['diff', '--stat', '--stat-width=999'], cwd);
  if (!raw) return null;

  const lines = raw.split('\n');
  const summaryLine = lines[lines.length - 1];
  if (!summaryLine) return null;

  const filesMatch = summaryLine.match(/(\d+) files? changed/);
  const insertMatch = summaryLine.match(/(\d+) insertions?\(\+\)/);
  const deleteMatch = summaryLine.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
  };
}

export async function collectGitContext(
  cwd: string,
  commitDepth: number,
): Promise<GitContext> {
  if (!(await isGitRepo(cwd))) {
    return { ...EMPTY_GIT_CONTEXT };
  }

  const [branch, upstream, status, recentCommits, stashes, mergeState, diff] =
    await Promise.all([
      getBranch(cwd),
      getUpstream(cwd),
      getStatus(cwd),
      getRecentCommits(cwd, commitDepth),
      getStashes(cwd),
      getMergeState(cwd),
      getDiffSummary(cwd),
    ]);

  return {
    isRepo: true,
    branch,
    upstream,
    status,
    recentCommits,
    stashes,
    mergeState,
    diff,
  };
}
