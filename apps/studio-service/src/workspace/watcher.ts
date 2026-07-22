import { watch, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

/**
 * Workspace file watcher (plan §16). Watches the workspace tree, debounces
 * events, ignores node_modules / temp / Excel intermediate files, and emits a
 * 'changed' notification so the UI can re-fetch computed state. It never infers
 * success from a file event — the UI re-reads indexes/validation.
 */
const IGNORE = /(?:^|[\\/])(?:node_modules|\.git|work[\\/]\.checkpoints)(?:[\\/]|$)|\.tmp-|~\$|\.crdownload$/;

export class WorkspaceWatcher extends EventEmitter {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private readonly debounceMs: number;

  constructor(
    private readonly workspaceRoot: string,
    options: { debounceMs?: number } = {},
  ) {
    super();
    this.debounceMs = options.debounceMs ?? 250;
  }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.workspaceRoot, { recursive: true }, (_event, filename) => {
        if (filename && IGNORE.test(filename.toString())) return;
        this.schedule(filename ? filename.toString() : '');
      });
    } catch {
      // Recursive watch may be unsupported on some platforms; degrade gracefully.
    }
  }

  private schedule(path: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.emit('changed', { path });
    }, this.debounceMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  get root(): string {
    return this.workspaceRoot;
  }

  static outputsDir(workspaceRoot: string): string {
    return join(workspaceRoot, 'outputs');
  }
}
