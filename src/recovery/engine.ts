import type {
  ContextSnapshot,
  RecoveryReport,
  WorkItem,
  InProgressItem,
  NextStep,
  TimelineEntry,
  AwayDuration,
} from '../types.js';

/**
 * Generate a recovery report by analyzing the current snapshot
 * and optionally comparing it against a previous snapshot.
 */
export function generateRecoveryReport(
  current: ContextSnapshot,
  previous: ContextSnapshot | null,
): RecoveryReport {
  const workingOn = inferWorkingOn(current);
  const inProgress = detectInProgress(current);
  const nextSteps = suggestNextSteps(current, inProgress);
  const timeline = buildTimeline(current);
  const away = previous ? computeAwayDuration(previous) : null;
  const summary = buildSummary(current, workingOn, inProgress, away);

  return {
    generatedAt: new Date().toISOString(),
    directory: current.directory,
    away,
    summary,
    workingOn,
    inProgress,
    nextSteps,
    timeline,
  };
}

// ─── Inference: What were you working on? ────────────────────────────────────

function inferWorkingOn(snapshot: ContextSnapshot): WorkItem[] {
  const items: WorkItem[] = [];

  // Signal 1: Branch name analysis (high confidence)
  if (snapshot.git.isRepo && snapshot.git.branch) {
    const branchWork = parseBranchName(snapshot.git.branch);
    if (branchWork) {
      items.push({
        description: branchWork,
        confidence: 'high',
        evidence: [`On branch \`${snapshot.git.branch}\``],
      });
    }
  }

  // Signal 2: Recent commit messages (high confidence)
  if (snapshot.git.recentCommits.length > 0) {
    const recentCommits = snapshot.git.recentCommits.slice(0, 5);
    const theme = extractCommitTheme(recentCommits.map((c) => c.message));
    if (theme) {
      items.push({
        description: theme,
        confidence: 'high',
        evidence: recentCommits.map((c) => `Commit \`${c.shortHash}\`: ${c.message}`),
      });
    }
  }

  // Signal 3: Uncommitted file analysis (medium confidence)
  const modifiedFiles = snapshot.git.status.filter((f) => f.status !== 'untracked');
  if (modifiedFiles.length > 0) {
    const fileGroups = groupFilesByModule(modifiedFiles.map((f) => f.file));
    for (const [module, files] of Object.entries(fileGroups)) {
      items.push({
        description: `Modifying ${module} (${files.length} file${files.length > 1 ? 's' : ''})`,
        confidence: 'medium',
        evidence: files.map((f) => `Changed: \`${f}\``),
      });
    }
  }

  // Signal 4: Recently modified files not in git (low confidence)
  if (snapshot.files.recentlyModified.length > 0 && !snapshot.git.isRepo) {
    const topFiles = snapshot.files.recentlyModified.slice(0, 5);
    items.push({
      description: `Editing files in ${snapshot.directory}`,
      confidence: 'low',
      evidence: topFiles.map((f) => `Modified: \`${f.relativePath}\` at ${formatTime(f.modifiedAt)}`),
    });
  }

  // Signal 5: Shell history patterns (low confidence)
  if (snapshot.shell.recentCommands.length > 0) {
    const devActivity = detectDevActivity(snapshot.shell.recentCommands.map((c) => c.command));
    if (devActivity) {
      items.push({
        description: devActivity,
        confidence: 'low',
        evidence: ['Inferred from recent shell commands'],
      });
    }
  }

  return items;
}

// ─── Detection: What's in progress? ─────────────────────────────────────────

function detectInProgress(snapshot: ContextSnapshot): InProgressItem[] {
  const items: InProgressItem[] = [];

  // Uncommitted changes
  const uncommitted = snapshot.git.status.filter((f) => f.status !== 'untracked');
  if (uncommitted.length > 0) {
    const staged = uncommitted.filter((f) => f.staged);
    const unstaged = uncommitted.filter((f) => !f.staged);

    if (staged.length > 0 && unstaged.length > 0) {
      items.push({
        type: 'partial_stage',
        description: `${staged.length} file${staged.length > 1 ? 's' : ''} staged, ${unstaged.length} unstaged — mid-commit`,
        files: uncommitted.map((f) => f.file),
        priority: 'high',
      });
    } else {
      items.push({
        type: 'uncommitted_changes',
        description: `${uncommitted.length} uncommitted change${uncommitted.length > 1 ? 's' : ''}`,
        files: uncommitted.map((f) => f.file),
        priority: 'medium',
      });
    }
  }

  // Untracked files
  const untracked = snapshot.git.status.filter((f) => f.status === 'untracked');
  if (untracked.length > 0 && untracked.length <= 10) {
    items.push({
      type: 'uncommitted_changes',
      description: `${untracked.length} new untracked file${untracked.length > 1 ? 's' : ''}`,
      files: untracked.map((f) => f.file),
      priority: 'low',
    });
  }

  // Merge/rebase/cherry-pick in progress
  if (snapshot.git.mergeState) {
    const ms = snapshot.git.mergeState;
    const desc = ms.type === 'rebase' && ms.progress
      ? `Rebase in progress (${ms.progress})`
      : `${capitalize(ms.type)} in progress`;
    items.push({
      type: 'merge_conflict',
      description: desc,
      files: snapshot.git.status.filter((f) => f.status === 'conflicted').map((f) => f.file),
      priority: 'high',
    });
  }

  // Stashed work
  if (snapshot.git.stashes.length > 0) {
    items.push({
      type: 'stashed_work',
      description: `${snapshot.git.stashes.length} stash${snapshot.git.stashes.length > 1 ? 'es' : ''}: "${snapshot.git.stashes[0].message}"`,
      files: [],
      priority: 'low',
    });
  }

  // Feature branch not merged
  if (snapshot.git.isRepo && snapshot.git.branch !== 'main' && snapshot.git.branch !== 'master') {
    items.push({
      type: 'open_branch',
      description: `On feature branch \`${snapshot.git.branch}\``,
      files: [],
      priority: 'low',
    });
  }

  return items;
}

// ─── Suggestions: What should you do next? ──────────────────────────────────

function suggestNextSteps(
  snapshot: ContextSnapshot,
  inProgress: InProgressItem[],
): NextStep[] {
  const steps: NextStep[] = [];

  // High priority: resolve merge conflicts
  const conflicts = inProgress.find((i) => i.type === 'merge_conflict');
  if (conflicts) {
    steps.push({
      action: `Resolve ${conflicts.files.length > 0 ? conflicts.files.length + ' conflict(s)' : 'the ' + snapshot.git.mergeState?.type}`,
      reason: `${capitalize(snapshot.git.mergeState?.type ?? 'merge')} is blocking further work`,
      priority: 'high',
    });
  }

  // High priority: partial staging suggests interrupted commit
  const partialStage = inProgress.find((i) => i.type === 'partial_stage');
  if (partialStage) {
    steps.push({
      action: 'Review staged changes and complete the commit',
      reason: 'You have a partially staged commit — you were likely mid-commit when interrupted',
      priority: 'high',
    });
  }

  // Medium: uncommitted changes
  const uncommitted = inProgress.find((i) => i.type === 'uncommitted_changes' && i.priority === 'medium');
  if (uncommitted && !partialStage) {
    const fileCount = uncommitted.files.length;
    if (fileCount <= 3) {
      steps.push({
        action: `Review and commit changes to: ${uncommitted.files.join(', ')}`,
        reason: 'Small changeset ready to commit',
        priority: 'medium',
      });
    } else {
      steps.push({
        action: `Review ${fileCount} uncommitted files and commit in logical chunks`,
        reason: 'Larger changeset — consider splitting into focused commits',
        priority: 'medium',
      });
    }
  }

  // Medium: continue work based on branch purpose
  if (snapshot.git.isRepo && snapshot.git.branch !== 'main' && snapshot.git.branch !== 'master') {
    const branchWork = parseBranchName(snapshot.git.branch);
    if (branchWork) {
      steps.push({
        action: `Continue: ${branchWork}`,
        reason: `Active feature branch \`${snapshot.git.branch}\``,
        priority: 'medium',
      });
    }
  }

  // Low: stashed work reminder
  const stash = inProgress.find((i) => i.type === 'stashed_work');
  if (stash) {
    steps.push({
      action: 'Consider applying stashed changes when ready',
      reason: stash.description,
      priority: 'low',
    });
  }

  // Low: recently modified test files suggest test cycle
  const testFiles = snapshot.files.recentlyModified.filter(
    (f) => f.relativePath.includes('test') || f.relativePath.includes('spec'),
  );
  if (testFiles.length > 0) {
    steps.push({
      action: 'Run tests — you were recently editing test files',
      reason: `Modified: ${testFiles.slice(0, 3).map((f) => f.relativePath).join(', ')}`,
      priority: 'medium',
    });
  }

  return steps;
}

// ─── Timeline: What happened recently? ──────────────────────────────────────

function buildTimeline(snapshot: ContextSnapshot): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // Add recent commits to timeline
  for (const commit of snapshot.git.recentCommits.slice(0, 10)) {
    entries.push({
      time: commit.date,
      action: 'commit',
      details: `[${commit.shortHash}] ${commit.message} (${commit.filesChanged} file${commit.filesChanged !== 1 ? 's' : ''})`,
    });
  }

  // Add recently modified files (only top 10 to keep timeline focused)
  for (const file of snapshot.files.recentlyModified.slice(0, 10)) {
    entries.push({
      time: file.modifiedAt,
      action: 'file_modified',
      details: `${file.relativePath}${file.language ? ` (${file.language})` : ''}`,
    });
  }

  // Add shell commands with timestamps
  for (const cmd of snapshot.shell.recentCommands) {
    if (cmd.timestamp) {
      entries.push({
        time: cmd.timestamp,
        action: 'command',
        details: cmd.command,
      });
    }
  }

  // Sort by time, newest first
  entries.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return entries.slice(0, 25);
}

// ─── Summary ────────────────────────────────────────────────────────────────

function buildSummary(
  snapshot: ContextSnapshot,
  workingOn: WorkItem[],
  inProgress: InProgressItem[],
  away: AwayDuration | null,
): string {
  const parts: string[] = [];

  if (away) {
    parts.push(`You've been away for ${away.humanized}.`);
  }

  // Main work description
  const highConfidence = workingOn.filter((w) => w.confidence === 'high');
  if (highConfidence.length > 0) {
    parts.push(`You were working on: ${highConfidence[0].description}.`);
  } else if (workingOn.length > 0) {
    parts.push(`You were likely working on: ${workingOn[0].description}.`);
  }

  // Branch context
  if (snapshot.git.isRepo) {
    parts.push(`Branch: \`${snapshot.git.branch}\`.`);
  }

  // Urgent items
  const urgent = inProgress.filter((i) => i.priority === 'high');
  if (urgent.length > 0) {
    parts.push(`Needs attention: ${urgent.map((i) => i.description).join('; ')}.`);
  }

  // Change stats
  const uncommittedCount = snapshot.git.status.filter((f) => f.status !== 'untracked').length;
  if (uncommittedCount > 0) {
    parts.push(`${uncommittedCount} uncommitted change${uncommittedCount > 1 ? 's' : ''}.`);
  }

  return parts.join(' ');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeAwayDuration(previous: ContextSnapshot): AwayDuration {
  const since = previous.timestamp;
  const ms = Date.now() - new Date(since).getTime();

  let humanized: string;
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    humanized = `${days} day${days > 1 ? 's' : ''}${hours % 24 > 0 ? `, ${hours % 24}h` : ''}`;
  } else if (hours > 0) {
    humanized = `${hours} hour${hours > 1 ? 's' : ''}${minutes % 60 > 0 ? `, ${minutes % 60}m` : ''}`;
  } else {
    humanized = `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }

  return { since, humanized };
}

function parseBranchName(branch: string): string | null {
  if (branch === 'main' || branch === 'master' || branch === 'develop') {
    return null;
  }

  // Common patterns: feature/xxx, fix/xxx, bugfix/xxx, feat/xxx, chore/xxx
  const prefixMatch = branch.match(
    /^(feat|feature|fix|bugfix|hotfix|chore|refactor|docs|test|ci|perf)\/(.*)/i,
  );

  if (prefixMatch) {
    const type = prefixMatch[1].toLowerCase();
    const desc = prefixMatch[2]
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase();

    const typeMap: Record<string, string> = {
      feat: 'Feature', feature: 'Feature',
      fix: 'Bug fix', bugfix: 'Bug fix', hotfix: 'Hot fix',
      chore: 'Chore', refactor: 'Refactoring',
      docs: 'Documentation', test: 'Testing', ci: 'CI/CD', perf: 'Performance',
    };

    return `${typeMap[type] ?? capitalize(type)}: ${desc}`;
  }

  // Ticket patterns: PROJ-123-description or just PROJ-123
  const ticketMatch = branch.match(/^([A-Z]+-\d+)[-_]?(.*)/);
  if (ticketMatch) {
    const ticket = ticketMatch[1];
    const desc = ticketMatch[2]
      ? ticketMatch[2].replace(/[-_]/g, ' ').toLowerCase()
      : '';
    return desc ? `${ticket}: ${desc}` : `Ticket ${ticket}`;
  }

  // Fallback: humanize the branch name
  const humanized = branch
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();

  return humanized !== branch ? capitalize(humanized) : null;
}

function extractCommitTheme(messages: string[]): string | null {
  if (messages.length === 0) return null;

  // Look for conventional commit prefixes
  const prefixCounts: Record<string, number> = {};
  for (const msg of messages) {
    const match = msg.match(/^(feat|fix|chore|refactor|docs|test|ci|perf|style|build)[\s(:]/i);
    if (match) {
      const prefix = match[1].toLowerCase();
      prefixCounts[prefix] = (prefixCounts[prefix] ?? 0) + 1;
    }
  }

  const dominant = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= messages.length / 2) {
    const typeMap: Record<string, string> = {
      feat: 'adding features', fix: 'fixing bugs', chore: 'maintenance work',
      refactor: 'refactoring', docs: 'documentation', test: 'writing tests',
      ci: 'CI/CD changes', perf: 'performance optimization',
    };
    return `Recent commits suggest ${typeMap[dominant[0]] ?? dominant[0]}`;
  }

  // Use the most recent commit as context
  return `Latest commit: "${messages[0]}"`;
}

function groupFilesByModule(files: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};

  for (const file of files) {
    const parts = file.split('/');
    let module: string;

    if (parts.length >= 2) {
      // Use top-level directory as module name
      module = parts[0];
      if (module === 'src' && parts.length >= 3) {
        module = `src/${parts[1]}`;
      }
    } else {
      module = 'root';
    }

    if (!groups[module]) groups[module] = [];
    groups[module].push(file);
  }

  return groups;
}

function detectDevActivity(commands: string[]): string | null {
  let testCommands = 0;
  let buildCommands = 0;
  let installCommands = 0;
  let dockerCommands = 0;

  for (const cmd of commands) {
    if (cmd.match(/\b(test|jest|vitest|pytest|mocha|cargo test|go test)\b/)) testCommands++;
    if (cmd.match(/\b(build|compile|tsc|webpack|vite build|cargo build|go build)\b/)) buildCommands++;
    if (cmd.match(/\b(install|npm i|yarn add|pip install|cargo add)\b/)) installCommands++;
    if (cmd.match(/\b(docker|docker-compose|podman)\b/)) dockerCommands++;
  }

  if (testCommands >= 3) return 'Actively running tests (test-driven development cycle)';
  if (buildCommands >= 2) return 'Working on build/compilation issues';
  if (installCommands >= 2) return 'Setting up or adding dependencies';
  if (dockerCommands >= 2) return 'Working with containers/Docker';

  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ─── Formatting: Render report as readable text ─────────────────────────────

export function formatReportAsText(report: RecoveryReport): string {
  const lines: string[] = [];

  // Header
  lines.push('# Context Recovery Report');
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  // What you were working on
  if (report.workingOn.length > 0) {
    lines.push('## What You Were Working On');
    lines.push('');
    for (const item of report.workingOn) {
      const icon = item.confidence === 'high' ? '●' : item.confidence === 'medium' ? '◐' : '○';
      lines.push(`${icon} **${item.description}** (${item.confidence} confidence)`);
      for (const ev of item.evidence.slice(0, 3)) {
        lines.push(`  - ${ev}`);
      }
    }
    lines.push('');
  }

  // In progress
  if (report.inProgress.length > 0) {
    lines.push('## In Progress');
    lines.push('');
    for (const item of report.inProgress) {
      const priority = item.priority === 'high' ? '🔴' : item.priority === 'medium' ? '🟡' : '⚪';
      lines.push(`${priority} ${item.description}`);
      if (item.files.length > 0) {
        for (const f of item.files.slice(0, 5)) {
          lines.push(`   - \`${f}\``);
        }
        if (item.files.length > 5) {
          lines.push(`   - ...and ${item.files.length - 5} more`);
        }
      }
    }
    lines.push('');
  }

  // Next steps
  if (report.nextSteps.length > 0) {
    lines.push('## Suggested Next Steps');
    lines.push('');
    for (let i = 0; i < report.nextSteps.length; i++) {
      const step = report.nextSteps[i];
      lines.push(`${i + 1}. **${step.action}**`);
      lines.push(`   _${step.reason}_`);
    }
    lines.push('');
  }

  // Timeline
  if (report.timeline.length > 0) {
    lines.push('## Recent Activity Timeline');
    lines.push('');
    for (const entry of report.timeline.slice(0, 15)) {
      const time = formatTime(entry.time);
      const icon = entry.action === 'commit' ? '📝' : entry.action === 'command' ? '⌨️' : '📄';
      lines.push(`${icon} \`${time}\` ${entry.details ?? entry.action}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
