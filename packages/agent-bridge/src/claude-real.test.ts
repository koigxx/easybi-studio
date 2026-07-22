import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeBridge } from './claude-bridge.js';
import type { AgentEvent } from '@easybi-studio/contracts';

/**
 * Real Claude Code integration (plan stage 5 exit criterion): Claude completes a
 * file task that does NOT touch a database. Skipped automatically when the CLI
 * is not present so CI without Claude still passes.
 */
const CLAUDE = join(homedir(), '.local', 'bin', 'claude');
let claudeAvailable = false;
try {
  accessSync(CLAUDE, constants.X_OK);
  claudeAvailable = true;
} catch {
  claudeAvailable = false;
}

const maybe = claudeAvailable ? describe : describe.skip;

let ws: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-ccreal-'));
});
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

maybe('ClaudeCodeBridge with the real Claude Code CLI', () => {
  it(
    'completes a no-database file task and writes into the workspace',
    async () => {
      const bridge = new ClaudeCodeBridge({ claudePath: CLAUDE });
      const health = await bridge.healthCheck();
      expect(health.available).toBe(true);

      const task = await bridge.start({
        projectId: 'real',
        workspaceRoot: ws,
        action: 'create-report',
        prompt:
          '在当前工作目录创建文件 easybi-real.txt，内容写一行：easybi-real-ok。' +
          '不要访问数据库，完成后立即停止，不要提出问题。',
      });

      const types: string[] = [];
      for await (const e of bridge.events(task.taskId) as AsyncIterable<AgentEvent>) {
        types.push(e.type);
      }

      expect(task.sessionId).toBeTruthy();
      expect(types).toContain('completed');

      const filePath = join(ws, 'easybi-real.txt');
      const exists = await stat(filePath).then(
        () => true,
        () => false,
      );
      expect(exists).toBe(true);
      const content = await readFile(filePath, 'utf8');
      expect(content).toContain('easybi-real-ok');
    },
    120_000,
  );
});
