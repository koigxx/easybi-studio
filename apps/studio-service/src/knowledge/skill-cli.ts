import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { WorkspaceSkillAdapter } from '@easybi-studio/workspace-sdk';

/**
 * Runs the knowledge skill's deterministic CLI (catalog-cli.js) for structural
 * operations that must stay consistent with the Skill contract: tier promotion,
 * validation, and publish. Studio never reimplements these — it shells out to the
 * bundled compiled CLI, resolved through the Manifest (no hardcoded deep paths).
 *
 * spawn is used with shell:false and array args; cwd is the skill directory so the
 * CLI resolves its own dist/ dependencies. No secrets are involved in these calls.
 */

const KNOWLEDGE_SKILL_ID = 'initialize-report-knowledge';

export interface CliResult {
  ok: boolean;
  /** Parsed JSON stdout when the CLI emits JSON; otherwise null. */
  json: unknown;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SkillCliRunner {
  run(workspaceRoot: string, args: string[]): Promise<CliResult>;
}

/** Real runner: spawns `node <catalog-cli.js> <args...>` from the skill directory. */
export class NodeSkillCliRunner implements SkillCliRunner {
  constructor(
    private readonly nodePath: string = process.execPath,
    private readonly timeoutMs: number = 120000,
  ) {}

  async run(workspaceRoot: string, args: string[]): Promise<CliResult> {
    const adapter = new WorkspaceSkillAdapter(workspaceRoot);
    const cliPath = await adapter.resolveCommand(KNOWLEDGE_SKILL_ID, 'cli');
    const cwd = dirname(dirname(cliPath)); // .../<skill>/dist/scripts -> .../<skill>

    return new Promise<CliResult>((resolve) => {
      const child = spawn(this.nodePath, [cliPath, ...args], {
        cwd,
        shell: false,
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, json: null, stdout, stderr: String(err.message ?? err), code: null });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let json: unknown = null;
        try {
          json = JSON.parse(stdout);
        } catch {
          json = null;
        }
        const jsonOk =
          json && typeof json === 'object' && 'ok' in (json as Record<string, unknown>)
            ? Boolean((json as Record<string, unknown>).ok)
            : code === 0;
        resolve({ ok: code === 0 && jsonOk, json, stdout, stderr, code });
      });
    });
  }
}
