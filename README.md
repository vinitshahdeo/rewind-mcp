# Rewind - Context Switching Recovery Agent

**Rewind** — an MCP server that reconstructs your working context after interruptions aka Context Switch.

Developers get interrupted constantly. Meetings, Slack messages, code reviews, lunch breaks. Every time you come back, you spend 10-20 minutes reloading your mental state: _"What was I doing? Which files were open? What's left to finish?"_

Rewind solves this. It's an [MCP server](https://modelcontextprotocol.io) that analyzes your git state, recently modified files, editor state, and shell history. When you return and ask **"where was I?"**, it reconstructs your exact working context — what you were editing, what problem you were solving, and what you need to do next.

## Tools

| Tool | Description |
|------|-------------|
| `where_was_i` | The main recovery tool. Analyzes your project and generates a full context recovery report with what you were working on, what's in progress, and suggested next steps. |
| `take_snapshot` | Saves a point-in-time snapshot of your working context. Use before stepping away so `where_was_i` can compare states. |
| `recent_activity` | Shows a chronological timeline of recent commits, file changes, and shell commands. |
| `get_context_status` | Shows tracked directories, snapshot counts, and storage info. |
| `diff_snapshots` | Compares a previous snapshot against current state to show exactly what changed. |

## What It Collects

**Git State** — current branch, uncommitted changes (staged/unstaged), recent commits, stashes, merge/rebase/cherry-pick state, diff summary.

**File Activity** — recently modified files with timestamps, file sizes, and detected languages. Respects configurable include/exclude patterns.

**Editor State** — detects VS Code, Cursor, JetBrains IDEs, and Vim. Reads workspace metadata to find open projects and files.

**Shell History** — parses zsh, bash, and fish history. Filters noise commands (`ls`, `cd`, etc.) and deduplicates.

## Setup

### With Claude Code

```bash
claude mcp add rewind node /absolute/path/to/rewind/dist/index.js
```

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rewind": {
      "command": "node",
      "args": ["/absolute/path/to/rewind/dist/index.js"]
    }
  }
}
```

### Build from Source

```bash
git clone <repo-url>
cd context-switch
npm install
npm run build
```

## Usage

Once configured, just ask Claude:

- **"Where was I?"** — triggers `where_was_i` on your current project
- **"Take a snapshot before my meeting"** — triggers `take_snapshot`
- **"What did I do this morning?"** — triggers `recent_activity` with appropriate time range
- **"What changed since my last snapshot?"** — triggers `diff_snapshots`

### Example Recovery Report

```
# Context Recovery Report

You've been away for 2 hours, 15m. You were working on: Feature: user authentication.
Branch: `feat/user-auth`. 3 uncommitted changes.

## What You Were Working On

● **Feature: user authentication** (high confidence)
  - On branch `feat/user-auth`
● **Latest commit: "add JWT token validation middleware"** (high confidence)
  - Commit `a1b2c3d`: add JWT token validation middleware (4 files)

## In Progress

🔴 2 files staged, 1 unstaged — mid-commit
   - `src/middleware/auth.ts`
   - `src/routes/login.ts`
   - `tests/auth.test.ts`
🟡 3 uncommitted changes
⚪ On feature branch `feat/user-auth`

## Suggested Next Steps

1. **Review staged changes and complete the commit**
   _You have a partially staged commit — you were likely mid-commit when interrupted_
2. **Run tests — you were recently editing test files**
   _Modified: tests/auth.test.ts_
3. **Continue: Feature: user authentication**
   _Active feature branch `feat/user-auth`_

## Recent Activity Timeline

📝 `02:15 PM` [a1b2c3d] add JWT token validation middleware (4 files)
📄 `02:30 PM` src/middleware/auth.ts (TypeScript)
📄 `02:28 PM` tests/auth.test.ts (TypeScript)
📝 `01:45 PM` [d4e5f6g] scaffold auth module structure (6 files)
⌨️ `02:25 PM` npm test -- --watch
```

## How It Works

### Signal Collection

All four collectors run in parallel for speed. Each collects an independent slice of context:

1. **Git Collector** — Shells out to `git` to read branch, status (porcelain format), log, stash list, and detects merge/rebase/cherry-pick state by inspecting `.git/` internals.

2. **File Collector** — Walks the project directory tree, respects configurable include/exclude patterns, and finds files modified within the configured time window (default: 2 hours).

3. **Editor Collector** — Reads VS Code/Cursor workspace storage metadata, JetBrains `.idea/workspace.xml`, and checks for Vim swap files. Also checks running processes.

4. **Shell Collector** — Parses `~/.zsh_history`, `~/.bash_history`, or fish history. Handles timestamped formats (zsh extended history) and filters noise.

### Recovery Engine

The recovery engine synthesizes collected signals into a structured report:

- **Branch name parsing** — Extracts work context from `feat/`, `fix/`, ticket patterns (`PROJ-123`), and camelCase/kebab-case branch names.
- **Commit theme detection** — Groups recent commits by conventional commit prefix to identify dominant work type.
- **In-progress detection** — Identifies partial staging (interrupted commit), merge conflicts, stashed work, and feature branches.
- **Next step suggestion** — Prioritizes by urgency: merge conflicts > partial commits > uncommitted changes > branch work > stash reminders.

### Snapshot Comparison

When `take_snapshot` is used before an interruption, `where_was_i` compares the previous snapshot with current state to show:
- How long you were away
- New commits since the snapshot
- Files that changed or were resolved
- Stash changes

## Configuration

Configuration is stored at `~/.rewind/config.json`. Defaults work out of the box:

```json
{
  "snapshotIntervalMs": 300000,
  "maxSnapshots": 200,
  "retentionHours": 72,
  "recentFileMinutes": 120,
  "gitCommitDepth": 15,
  "shellHistoryLines": 30,
  "filePatterns": {
    "include": ["**/*.ts", "**/*.js", "**/*.py", "..."],
    "exclude": ["**/node_modules/**", "**/dist/**", "..."]
  }
}
```

## Architecture

```
src/
├── index.ts                # Entry point — starts MCP server over stdio
├── server.ts               # MCP server with tool definitions
├── types.ts                # TypeScript type definitions
├── config/
│   └── index.ts            # Configuration management + app paths
├── collectors/
│   ├── index.ts            # Orchestrator — runs all collectors in parallel
│   ├── git.ts              # Git state collector
│   ├── files.ts            # File activity collector
│   ├── editor.ts           # Editor state collector
│   └── shell.ts            # Shell history collector
├── recovery/
│   └── engine.ts           # Recovery engine + report formatter
└── storage/
    └── store.ts            # Snapshot persistence + retention
```

## Privacy

All data stays local. Snapshots are stored in `~/.rewind/snapshots/` and never leave your machine. No network calls, no telemetry, no cloud storage.

## License

MIT
