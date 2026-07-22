import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, stat, rm, cp } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type {
  Checkpoint,
  CheckpointFileEntry,
  ChangeSummary,
  FileDiff,
  RollbackResult,
} from '@easybi-studio/contracts';
import { unifiedDiff } from './diff.js';

/**
 * File checkpoint / diff / rollback (plan §10.10).
 *
 * Before an agent write task, capture managed files (hash + recoverable copy).
 * After the task, compute a change summary. Rollback restores managed files that
 * changed during the task, and REFUSES when a file was modified again after the
 * task ended (conflict). Never touches published knowledge versions / report
 * packages, and never deletes unknown user files.
 */

const EXCLUDED_DIRS = new Set(['node_modules', 'work', '.git', 'skills']);
/** Immutable areas are captured for detection but never rolled back destructively. */
const PROTECTED_PREFIXES = ['knowledge/versions/', 'reports/packages/'];
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function listManagedFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(relative(root, join(dir, e.name)).split(sep).join('/'));
      }
    }
  }
  await walk(root);
  return out.sort();
}

export class CheckpointManager {
  /** Checkpoints live under <workspace>/work/.checkpoints/<id>. */
  private checkpointsDir(workspaceRoot: string): string {
    return join(workspaceRoot, 'work', '.checkpoints');
  }

  async create(options: {
    workspaceRoot: string;
    projectId: string;
    jobId?: string;
    bundleVersion?: string;
  }): Promise<Checkpoint> {
    const { workspaceRoot, projectId } = options;
    const id = `ckpt_${Date.now()}_${Math.floor(process.hrtime()[1] % 100000)}`;
    const dir = join(this.checkpointsDir(workspaceRoot), id);
    const backupDir = join(dir, 'files');
    await mkdir(backupDir, { recursive: true });

    const managed = await listManagedFiles(workspaceRoot);
    const files: CheckpointFileEntry[] = [];
    for (const rel of managed) {
      const abs = join(workspaceRoot, rel);
      const st = await stat(abs);
      const buf = await readFile(abs);
      const hasBackup = st.size <= MAX_BACKUP_BYTES;
      if (hasBackup) {
        const dest = join(backupDir, rel);
        await mkdir(join(dest, '..'), { recursive: true });
        await cp(abs, dest);
      }
      files.push({ path: rel, sha256: sha256(buf), size: st.size, hasBackup });
    }

    const checkpoint: Checkpoint = {
      id,
      projectId,
      createdAt: new Date().toISOString(),
      files,
      excludedDirectories: [...EXCLUDED_DIRS],
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.bundleVersion ? { bundleVersion: options.bundleVersion } : {}),
    };
    await writeFile(join(dir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2), 'utf8');
    return checkpoint;
  }

  async load(workspaceRoot: string, checkpointId: string): Promise<Checkpoint | null> {
    try {
      const raw = await readFile(
        join(this.checkpointsDir(workspaceRoot), checkpointId, 'checkpoint.json'),
        'utf8',
      );
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }

  async list(workspaceRoot: string): Promise<string[]> {
    try {
      return (await readdir(this.checkpointsDir(workspaceRoot))).sort();
    } catch {
      return [];
    }
  }

  /** Compute the change summary of the workspace relative to a checkpoint. */
  async summarize(workspaceRoot: string, checkpoint: Checkpoint): Promise<ChangeSummary> {
    const before = new Map(checkpoint.files.map((f) => [f.path, f]));
    const nowFiles = await listManagedFiles(workspaceRoot);
    const nowSet = new Set(nowFiles);

    const added: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];
    const binaryArtifacts: string[] = [];

    for (const rel of nowFiles) {
      const buf = await readFile(join(workspaceRoot, rel));
      const hash = sha256(buf);
      const prev = before.get(rel);
      const isBinary = buf.includes(0);
      if (!prev) {
        added.push(rel);
        if (isBinary) binaryArtifacts.push(rel);
      } else if (prev.sha256 !== hash) {
        modified.push(rel);
        if (isBinary) binaryArtifacts.push(rel);
      } else {
        unchanged.push(rel);
      }
    }
    const deleted = checkpoint.files.filter((f) => !nowSet.has(f.path)).map((f) => f.path);

    return {
      checkpointId: checkpoint.id,
      ...(checkpoint.jobId ? { jobId: checkpoint.jobId } : {}),
      addedFiles: added.sort(),
      modifiedFiles: modified.sort(),
      deletedFiles: deleted.sort(),
      unchangedFiles: unchanged.sort(),
      binaryArtifacts: binaryArtifacts.sort(),
    };
  }

  /** Produce a text diff for one file relative to the checkpoint backup. */
  async diffFile(
    workspaceRoot: string,
    checkpoint: Checkpoint,
    path: string,
  ): Promise<FileDiff> {
    const prev = checkpoint.files.find((f) => f.path === path);
    const backupPath = join(this.checkpointsDir(workspaceRoot), checkpoint.id, 'files', path);
    const currentAbs = join(workspaceRoot, path);

    const currentExists = await stat(currentAbs).then(
      () => true,
      () => false,
    );
    const oldBuf = prev?.hasBackup
      ? await readFile(backupPath).catch(() => null)
      : null;
    const newBuf = currentExists ? await readFile(currentAbs) : null;

    const binary = (oldBuf?.includes(0) ?? false) || (newBuf?.includes(0) ?? false);
    const kind: FileDiff['kind'] = !prev ? 'added' : !currentExists ? 'deleted' : 'modified';

    if (binary || (!oldBuf && !newBuf)) {
      return { path, kind, binary: true };
    }
    return {
      path,
      kind,
      binary: false,
      unifiedDiff: unifiedDiff(oldBuf?.toString('utf8') ?? '', newBuf?.toString('utf8') ?? '', path),
    };
  }

  /**
   * Roll back files that changed since the checkpoint. Refuses when a target
   * file was modified again AFTER the given `taskEndSnapshot` (conflict), and
   * never rolls back protected published areas.
   */
  async rollback(options: {
    workspaceRoot: string;
    checkpoint: Checkpoint;
    /** Post-task file hashes; used to detect later external modifications. */
    postTaskHashes: Record<string, string>;
  }): Promise<RollbackResult> {
    const { workspaceRoot, checkpoint, postTaskHashes } = options;
    const restored: string[] = [];
    const conflicted: string[] = [];
    const before = new Map(checkpoint.files.map((f) => [f.path, f]));

    const current = await listManagedFiles(workspaceRoot);
    const currentSet = new Set(current);

    // Files present now that differ from checkpoint -> candidates to restore/delete.
    for (const rel of current) {
      if (PROTECTED_PREFIXES.some((p) => rel.startsWith(p))) continue;
      const buf = await readFile(join(workspaceRoot, rel));
      const hash = sha256(buf);
      const prev = before.get(rel);
      if (prev && prev.sha256 === hash) continue; // unchanged since checkpoint

      // Conflict: file changed again after the task recorded its post-task hash.
      const post = postTaskHashes[rel];
      if (post !== undefined && post !== hash) {
        conflicted.push(rel);
        continue;
      }

      if (!prev) {
        // Added by the task -> remove it (only files the task created).
        if (post !== undefined) {
          await rm(join(workspaceRoot, rel), { force: true });
          restored.push(rel);
        }
        // If not in post snapshot, it's an unknown user file -> leave it.
      } else if (prev.hasBackup) {
        const backupPath = join(this.checkpointsDir(workspaceRoot), checkpoint.id, 'files', rel);
        await cp(backupPath, join(workspaceRoot, rel));
        restored.push(rel);
      }
    }

    // Files deleted by the task -> restore from backup.
    for (const f of checkpoint.files) {
      if (currentSet.has(f.path)) continue;
      if (PROTECTED_PREFIXES.some((p) => f.path.startsWith(p))) continue;
      if (f.hasBackup) {
        const backupPath = join(this.checkpointsDir(workspaceRoot), checkpoint.id, 'files', f.path);
        const dest = join(workspaceRoot, f.path);
        await mkdir(join(dest, '..'), { recursive: true });
        await cp(backupPath, dest);
        restored.push(f.path);
      }
    }

    return {
      checkpointId: checkpoint.id,
      restored: restored.sort(),
      conflicted: conflicted.sort(),
      ok: conflicted.length === 0,
    };
  }

  /** Snapshot current managed-file hashes (used to capture post-task state). */
  async snapshotHashes(workspaceRoot: string): Promise<Record<string, string>> {
    const files = await listManagedFiles(workspaceRoot);
    const out: Record<string, string> = {};
    for (const rel of files) {
      out[rel] = sha256(await readFile(join(workspaceRoot, rel)));
    }
    return out;
  }
}
