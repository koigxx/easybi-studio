import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Detect the local Claude Code CLI without launching an agent (plan §14.1).
 * Read-only probe. Never reads or stores API keys.
 */
export interface ClaudeInfo {
  path?: string;
  version?: string;
}

const CANDIDATES = [
  join(homedir(), '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
];

export function detectClaude(env: NodeJS.ProcessEnv = process.env): ClaudeInfo {
  const explicit = env.EASYBI_CLAUDE_PATH;
  const candidates = explicit ? [explicit, ...CANDIDATES] : CANDIDATES;

  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK);
    } catch {
      continue;
    }
    // args as array, shell:false is default for spawnSync when given a file.
    const res = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (res.status === 0) {
      return { path: p, version: (res.stdout ?? '').trim() || undefined };
    }
    return { path: p };
  }
  return {};
}
