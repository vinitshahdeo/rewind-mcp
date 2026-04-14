import crypto from 'node:crypto';
import type { ContextSnapshot, ContextSwitchConfig } from '../types.js';
import { collectGitContext } from './git.js';
import { collectFileContext } from './files.js';
import { collectEditorContext } from './editor.js';
import { collectShellContext } from './shell.js';

/**
 * Collect a full context snapshot for the given directory.
 * Runs all collectors in parallel for speed.
 */
export async function collectSnapshot(
  directory: string,
  config: ContextSwitchConfig,
  source: 'auto' | 'manual' = 'manual',
): Promise<ContextSnapshot> {
  const [git, files, editor, shell] = await Promise.all([
    collectGitContext(directory, config.gitCommitDepth),
    collectFileContext(directory, config),
    collectEditorContext(directory),
    collectShellContext(config.shellHistoryLines),
  ]);

  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source,
    directory,
    git,
    files,
    editor,
    shell,
  };
}
