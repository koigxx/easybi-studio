import { isAbsolute, normalize, resolve, relative, sep } from 'node:path';

/**
 * Path normalization and workspace-root whitelist (plan §17).
 *
 * Every workspace path must be absolute, normalized, and contained within an
 * allowed root. Traversal outside an allowed root is rejected. These functions
 * do not touch the filesystem — they are pure and unit-testable.
 */

export class PathNotAllowedError extends Error {
  readonly code = 'PATH_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'PathNotAllowedError';
  }
}

export class PathTraversalError extends Error {
  readonly code = 'PATH_TRAVERSAL';
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/** Normalize to an absolute, canonical path string (no trailing separator). */
export function normalizeAbsolute(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new PathNotAllowedError('路径为空或不是字符串');
  }
  if (!isAbsolute(input)) {
    throw new PathNotAllowedError(`路径必须是绝对路径：${input}`);
  }
  const norm = normalize(input);
  // Strip a single trailing separator (but keep root '/').
  if (norm.length > 1 && norm.endsWith(sep)) {
    return norm.slice(0, -1);
  }
  return norm;
}

/** True when `child` is the same as or nested within `root`. */
export function isWithin(root: string, child: string): boolean {
  const r = normalizeAbsolute(root);
  const c = normalizeAbsolute(child);
  if (c === r) return true;
  const rel = relative(r, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Assert that `candidate` resolves within one of `allowedRoots`.
 * Returns the normalized absolute candidate path on success.
 */
export function assertWithinAllowedRoots(candidate: string, allowedRoots: string[]): string {
  const c = normalizeAbsolute(candidate);
  // Detect explicit traversal segments in the raw input for a clearer error.
  if (candidate.includes('..')) {
    // Still resolve; containment check below is authoritative, but flag traversal.
    const contained = allowedRoots.some((root) => isWithin(root, c));
    if (!contained) {
      throw new PathTraversalError(`路径包含穿越且不在允许根目录内：${candidate}`);
    }
  }
  const ok = allowedRoots.some((root) => isWithin(root, c));
  if (!ok) {
    throw new PathNotAllowedError(`路径不在允许的根目录内：${c}`);
  }
  return c;
}

/** Resolve a workspace-relative logical path safely under a workspace root. */
export function resolveWithinWorkspace(workspaceRoot: string, relativePath: string): string {
  const root = normalizeAbsolute(workspaceRoot);
  const resolved = normalizeAbsolute(resolve(root, relativePath));
  if (!isWithin(root, resolved)) {
    throw new PathTraversalError(`工作区相对路径越界：${relativePath}`);
  }
  return resolved;
}
