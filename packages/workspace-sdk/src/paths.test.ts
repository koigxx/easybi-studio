import { describe, it, expect } from 'vitest';
import {
  normalizeAbsolute,
  isWithin,
  assertWithinAllowedRoots,
  resolveWithinWorkspace,
  PathNotAllowedError,
  PathTraversalError,
} from './paths.js';

const ROOT = '/Users/admin/innos/easy-bi-workspace/easybi-studio-workspaces';

describe('normalizeAbsolute', () => {
  it('rejects relative paths', () => {
    expect(() => normalizeAbsolute('foo/bar')).toThrow(PathNotAllowedError);
  });

  it('rejects empty', () => {
    expect(() => normalizeAbsolute('')).toThrow(PathNotAllowedError);
  });

  it('strips trailing separator', () => {
    expect(normalizeAbsolute('/a/b/')).toBe('/a/b');
  });

  it('collapses . and ..', () => {
    expect(normalizeAbsolute('/a/b/../c')).toBe('/a/c');
  });
});

describe('isWithin', () => {
  it('same path is within', () => {
    expect(isWithin(ROOT, ROOT)).toBe(true);
  });

  it('nested path is within', () => {
    expect(isWithin(ROOT, `${ROOT}/transport-test`)).toBe(true);
  });

  it('sibling path is not within', () => {
    expect(isWithin(ROOT, '/Users/admin/innos/easy-bi-workspace/easy-bi')).toBe(false);
  });

  it('prefix-but-not-child is not within', () => {
    expect(isWithin('/a/foo', '/a/foobar')).toBe(false);
  });
});

describe('assertWithinAllowedRoots', () => {
  it('accepts a workspace under the allowed root', () => {
    const p = assertWithinAllowedRoots(`${ROOT}/t1`, [ROOT]);
    expect(p).toBe(`${ROOT}/t1`);
  });

  it('rejects a path outside allowed roots', () => {
    expect(() => assertWithinAllowedRoots('/etc/passwd', [ROOT])).toThrow(PathNotAllowedError);
  });

  it('rejects traversal that escapes the allowed root', () => {
    expect(() => assertWithinAllowedRoots(`${ROOT}/../../../etc`, [ROOT])).toThrow(
      PathTraversalError,
    );
  });

  it('allows traversal that stays within the allowed root', () => {
    const p = assertWithinAllowedRoots(`${ROOT}/a/../b`, [ROOT]);
    expect(p).toBe(`${ROOT}/b`);
  });
});

describe('resolveWithinWorkspace', () => {
  it('resolves a logical path under the workspace', () => {
    expect(resolveWithinWorkspace(ROOT, 'skills/bundle.manifest.json')).toBe(
      `${ROOT}/skills/bundle.manifest.json`,
    );
  });

  it('rejects a relative path escaping the workspace', () => {
    expect(() => resolveWithinWorkspace(ROOT, '../secret')).toThrow(PathTraversalError);
  });
});
