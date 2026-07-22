import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';
import { WorkspaceSkillAdapter } from '@easybi-studio/workspace-sdk';
import { allocatePort } from './port.js';

/**
 * Runtime Supervisor (plan §15).
 *
 * - At most one test Runtime per workspace.
 * - Dynamic local port; binds 127.0.0.1 only.
 * - Tracks projectId -> {pid, port}.
 * - Stops only processes Studio started; never kills foreign processes.
 * - Resolves the runtime entry from the installed bundle manifest (runtime_cli).
 */
export interface RuntimeInstance {
  projectId: string;
  pid: number;
  port: number;
  startedAt: string;
  status: 'starting' | 'running' | 'stopped';
}

interface Managed {
  info: RuntimeInstance;
  child: ChildProcessWithoutNullStreams;
  logTail: string[];
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/api/v1/reports`;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export class RuntimeSupervisor {
  private managed = new Map<string, Managed>();

  constructor(private readonly nodePath: string = process.execPath) {}

  isRunning(projectId: string): boolean {
    return this.managed.get(projectId)?.info.status === 'running';
  }

  status(projectId: string): RuntimeInstance | null {
    return this.managed.get(projectId)?.info ?? null;
  }

  logs(projectId: string): string[] {
    return this.managed.get(projectId)?.logTail ?? [];
  }

  /** Start (or return existing) Runtime for a workspace. */
  async start(projectId: string, workspaceRoot: string): Promise<RuntimeInstance> {
    const existing = this.managed.get(projectId);
    if (existing && existing.info.status !== 'stopped') return existing.info;

    const adapter = new WorkspaceSkillAdapter(workspaceRoot);
    const runtimeCli = await adapter.resolveCommand('create-report-package', 'runtime_cli');

    // Bootstrap runtime dependencies (local-first; skips when already present).
    const bootstrap = await adapter.resolveBootstrap('create-report-package');
    if (bootstrap) {
      // Strip package-manager env (npm_execpath etc.) so the bootstrap script's
      // internal `npm ci` uses npm, not whatever launched Studio (e.g. pnpm).
      const cleanEnv: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('npm_') || k === 'npm_execpath' || k === 'npm_config_user_agent') continue;
        cleanEnv[k] = v;
      }
      const res = spawnSync(this.nodePath, [bootstrap, 'runtime'], {
        cwd: dirname(dirname(bootstrap)),
        shell: false,
        env: cleanEnv,
        encoding: 'utf8',
      });
      if (res.status !== 0) {
        throw new Error(
          `Runtime 依赖准备失败：${((res.stderr ?? '') + (res.stdout ?? '')).slice(0, 200)}`,
        );
      }
    }

    const port = await allocatePort();

    const child = spawn(
      this.nodePath,
      [runtimeCli, 'serve', '--workspace', workspaceRoot, '--host', '127.0.0.1', '--port', String(port)],
      { cwd: workspaceRoot, shell: false, env: process.env },
    );

    const info: RuntimeInstance = {
      projectId,
      pid: child.pid ?? -1,
      port,
      startedAt: new Date().toISOString(),
      status: 'starting',
    };
    const logTail: string[] = [];
    const pushLog = (d: Buffer): void => {
      logTail.push(String(d));
      if (logTail.length > 200) logTail.shift();
    };
    child.stdout.on('data', pushLog);
    child.stderr.on('data', pushLog);
    child.on('exit', () => {
      info.status = 'stopped';
    });

    const managed: Managed = { info, child, logTail };
    this.managed.set(projectId, managed);

    const healthy = await waitForHealth(port, 30_000);
    if (!healthy) {
      this.stop(projectId);
      throw new Error('Runtime 启动后健康检查失败');
    }
    info.status = 'running';
    return info;
  }

  /** Stop only the process Studio started for this workspace. */
  stop(projectId: string): boolean {
    const m = this.managed.get(projectId);
    if (!m) return false;
    if (!m.child.killed && m.info.status !== 'stopped') {
      m.child.kill('SIGTERM');
    }
    m.info.status = 'stopped';
    this.managed.delete(projectId);
    return true;
  }

  /** Stop all Studio-started Runtimes (on Studio exit). */
  stopAll(): void {
    for (const id of [...this.managed.keys()]) this.stop(id);
  }

  baseUrl(projectId: string): string | null {
    const m = this.managed.get(projectId);
    if (!m || m.info.status === 'stopped') return null;
    return `http://127.0.0.1:${m.info.port}`;
  }
}
