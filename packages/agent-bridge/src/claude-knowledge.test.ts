import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeBridge } from './claude-bridge.js';
import type { AgentEvent } from '@easybi-studio/contracts';

/**
 * Stage 6 exit criterion (knowledge guided flow): with the real Claude CLI and a
 * bundled Skill available, Claude reads the initialize-report-knowledge SKILL and
 * correctly identifies the MySQL connection info it must collect — i.e. it hits
 * the human input gate instead of fabricating a scan. Skipped when the CLI or the
 * synced bundle is unavailable, so DB-less/CI runs still pass.
 */
const CLAUDE = join(homedir(), '.local', 'bin', 'claude');
const BUNDLE = join(homedir(), '.easybi-studio', 'skill-cache', 'easybi', '1.33.1');

let ok = false;
try {
  accessSync(CLAUDE, constants.X_OK);
  accessSync(
    join(BUNDLE, 'skills', 'initialize-report-knowledge', 'SKILL.md'),
    constants.R_OK,
  );
  // The synced immutable cache holds the whitelisted skills.
  ok = true;
} catch {
  ok = false;
}

const maybe = ok ? describe : describe.skip;
let ws: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-k6-'));
  if (ok) await cp(join(BUNDLE, 'skills'), join(ws, 'skills'), { recursive: true });
});
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

maybe('knowledge guided flow with real Claude', () => {
  it(
    'reads the SKILL and identifies the required MySQL connection info (input gate)',
    async () => {
      const bridge = new ClaudeCodeBridge({ claudePath: CLAUDE });
      const task = await bridge.start({
        projectId: 'k',
        workspaceRoot: ws,
        action: 'initialize-knowledge',
        prompt:
          '阅读 skills/initialize-report-knowledge/SKILL.md 的“Configure MySQL”一节，' +
          '仅用一句话回答：初始化知识库前需要用户提供哪些 MySQL 连接信息？不要执行扫描或写文件。',
      });
      let summary = '';
      for await (const e of bridge.events(task.taskId) as AsyncIterable<AgentEvent>) {
        if (e.type === 'completed') summary = e.summary ?? '';
      }
      expect(task.status).toBe('SUCCEEDED');
      // Expect it to mention host / database — the connection gate.
      expect(summary).toMatch(/host|主机|数据库|database/i);
    },
    120_000,
  );
});
