import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  Project,
  RegisterProjectInput,
  WorkspaceStructureCheck,
} from '@easybi-studio/contracts';
import {
  assertWithinAllowedRoots,
  checkWorkspaceStructure,
  PathNotAllowedError,
  PathTraversalError,
} from '@easybi-studio/workspace-sdk';

/** Domain errors surfaced to the API layer with stable codes. */
export class ProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

interface ProjectRow {
  id: string;
  name: string;
  workspace_root: string;
  skill_source_type: string | null;
  bundle_version: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProject(r: ProjectRow): Project {
  const p: Project = {
    id: r.id,
    name: r.name,
    workspaceRoot: r.workspace_root,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.skill_source_type) p.skillSourceType = r.skill_source_type as Project['skillSourceType'];
  if (r.bundle_version) p.bundleVersion = r.bundle_version;
  return p;
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return base || 'workspace';
}

export interface ProjectServiceOptions {
  db: Database.Database;
  /** Absolute allowed workspace roots (test workspaces live under this root). */
  allowedWorkspaceRoots: string[];
}

export class ProjectService {
  private readonly db: Database.Database;
  private readonly allowedRoots: string[];

  constructor(options: ProjectServiceOptions) {
    this.db = options.db;
    this.allowedRoots = options.allowedWorkspaceRoots;
  }

  /** Validate that a path is allowed and inspect its structure (read-only). */
  async validateWorkspacePath(workspaceRoot: string): Promise<WorkspaceStructureCheck> {
    const normalized = this.assertAllowed(workspaceRoot);
    return checkWorkspaceStructure(normalized);
  }

  private assertAllowed(workspaceRoot: string): string {
    try {
      return assertWithinAllowedRoots(workspaceRoot, this.allowedRoots);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        throw new ProjectError('PATH_TRAVERSAL', err.message);
      }
      if (err instanceof PathNotAllowedError) {
        throw new ProjectError('PATH_NOT_ALLOWED', err.message);
      }
      throw err;
    }
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : undefined;
  }

  getByWorkspaceRoot(workspaceRoot: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE workspace_root = ?').get(
      workspaceRoot,
    ) as ProjectRow | undefined;
    return row ? rowToProject(row) : undefined;
  }

  /**
   * Register an existing directory as a project. Does NOT create or modify the
   * workspace on disk — that is bootstrap's job (stage 2). Registration only
   * requires the path to be allowed and to be a real directory.
   */
  async register(input: RegisterProjectInput): Promise<Project> {
    if (!input.name || !input.name.trim()) {
      throw new ProjectError('VALIDATION_FAILED', '缺少工作区名称');
    }
    const normalized = this.assertAllowed(input.workspaceRoot);

    const check = await checkWorkspaceStructure(normalized);
    if (!check.exists || !check.isDirectory) {
      throw new ProjectError('WORKSPACE_INVALID', '目标路径不存在或不是目录');
    }
    if (!check.registrable) {
      throw new ProjectError('WORKSPACE_INVALID', '目标路径不可登记为工作区');
    }

    if (this.getByWorkspaceRoot(normalized)) {
      throw new ProjectError('ALREADY_REGISTERED', '该工作区路径已登记');
    }

    const id = (input.id && input.id.trim()) || slugify(input.name);
    if (this.get(id)) {
      throw new ProjectError('ALREADY_REGISTERED', `项目 ID 已存在：${id}`);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, workspace_root, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name.trim(), normalized, now, now);

    const created = this.get(id);
    if (!created) throw new ProjectError('INTERNAL', '登记后未能读取项目');
    return created;
  }

  /**
   * Create a brand-new workspace under the first allowed root and register it.
   *
   * Path is derived from a slug of the name/id (never user-supplied absolute
   * path), so it always lands inside the allowed root. Refuses to reuse an
   * existing id or a directory that is already a bootstrapped workspace. The
   * `install` callback performs source -> cache -> workspace install + bootstrap.
   */
  async createWorkspace<T>(
    input: { name: string; id?: string },
    install: (workspaceRoot: string, id: string) => Promise<T>,
  ): Promise<{ project: Project; result: T }> {
    if (!input.name || !input.name.trim()) {
      throw new ProjectError('VALIDATION_FAILED', '缺少工作区名称');
    }
    const root = this.allowedRoots[0];
    if (!root) throw new ProjectError('INTERNAL', '未配置允许的工作区根目录');

    const id = (input.id && input.id.trim()) || slugify(input.name);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new ProjectError('VALIDATION_FAILED', 'ID 只能包含小写字母、数字和连字符');
    }
    if (this.get(id)) {
      throw new ProjectError('ALREADY_REGISTERED', `项目 ID 已存在：${id}`);
    }

    const workspaceRoot = this.assertAllowed(join(root, id));
    if (this.getByWorkspaceRoot(workspaceRoot)) {
      throw new ProjectError('ALREADY_REGISTERED', '该工作区路径已登记');
    }
    // Refuse to clobber a directory that already looks like an installed workspace.
    const existing = await checkWorkspaceStructure(workspaceRoot);
    if (existing.exists && existing.hasBundleManifest) {
      throw new ProjectError(
        'ALREADY_REGISTERED',
        `目标目录已是一个工作区：${workspaceRoot}（请改用“打开工作区”或换一个名称）`,
      );
    }

    // Install skill bundle + bootstrap the directory.
    const result = await install(workspaceRoot, id);

    // Register.
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, workspace_root, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name.trim(), workspaceRoot, now, now);
    const project = this.get(id);
    if (!project) throw new ProjectError('INTERNAL', '登记后未能读取项目');
    return { project, result };
  }

  /**
   * Remove registration only. Never deletes workspace files on disk (plan §12.1).
   * Returns true when a row was removed.
   */
  removeRegistration(id: string): boolean {
    const info = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return info.changes > 0;
  }
}
