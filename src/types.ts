// ─── Core Snapshot Types ─────────────────────────────────────────────────────

export interface ContextSnapshot {
  id: string;
  timestamp: string;
  source: 'auto' | 'manual';
  directory: string;
  git: GitContext;
  files: FileContext;
  editor: EditorContext;
  shell: ShellContext;
}

// ─── Git Context ─────────────────────────────────────────────────────────────

export interface GitContext {
  isRepo: boolean;
  branch: string;
  upstream: string | null;
  status: GitFileStatus[];
  recentCommits: GitCommit[];
  stashes: GitStash[];
  mergeState: MergeState | null;
  diff: DiffSummary | null;
}

export interface GitFileStatus {
  file: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
}

export interface GitStash {
  index: number;
  message: string;
  date: string;
}

export interface MergeState {
  type: 'merge' | 'rebase' | 'cherry-pick';
  branch?: string;
  progress?: string;
}

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

// ─── File Context ────────────────────────────────────────────────────────────

export interface FileContext {
  recentlyModified: RecentFile[];
}

export interface RecentFile {
  path: string;
  relativePath: string;
  modifiedAt: string;
  sizeBytes: number;
  language: string | null;
}

// ─── Editor Context ──────────────────────────────────────────────────────────

export interface EditorContext {
  detected: boolean;
  type: 'vscode' | 'cursor' | 'jetbrains' | 'unknown';
  openFiles: string[];
  workspaceFolder: string | null;
  recentlyOpenedPaths: string[];
}

// ─── Shell Context ───────────────────────────────────────────────────────────

export interface ShellContext {
  shell: string;
  recentCommands: ShellCommand[];
}

export interface ShellCommand {
  command: string;
  timestamp: string | null;
}

// ─── Recovery Report ─────────────────────────────────────────────────────────

export interface RecoveryReport {
  generatedAt: string;
  directory: string;
  away: AwayDuration | null;
  summary: string;
  workingOn: WorkItem[];
  inProgress: InProgressItem[];
  nextSteps: NextStep[];
  timeline: TimelineEntry[];
}

export interface AwayDuration {
  since: string;
  humanized: string;
}

export interface WorkItem {
  description: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface InProgressItem {
  type:
    | 'uncommitted_changes'
    | 'open_branch'
    | 'stashed_work'
    | 'merge_conflict'
    | 'partial_stage'
    | 'todo_items';
  description: string;
  files: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface NextStep {
  action: string;
  reason: string;
  priority: 'high' | 'medium' | 'low';
}

export interface TimelineEntry {
  time: string;
  action: string;
  details: string | null;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ContextSwitchConfig {
  watchDirectories: string[];
  snapshotIntervalMs: number;
  maxSnapshots: number;
  retentionHours: number;
  filePatterns: {
    include: string[];
    exclude: string[];
  };
  recentFileMinutes: number;
  gitCommitDepth: number;
  shellHistoryLines: number;
}

// ─── Daemon Types ────────────────────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  uptime: string | null;
  watchedDirectories: string[];
  lastSnapshot: string | null;
  snapshotCount: number;
}
