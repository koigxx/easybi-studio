import { mkdir, copyFile, readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import type { BundleManifest } from '@easybi-studio/contracts';
import {
  BUNDLE_COMMON_FILES,
  TOOLKIT_FILES,
  isSkillFileIncluded,
} from './whitelist.js';

/**
 * Copy the whitelisted Skill bundle from a canonical source directory into a
 * destination directory. Pure copy — never writes back to the source.
 *
 * Layout produced under destination:
 *   skills/index.json
 *   skills/bundle.manifest.json
 *   skills/目录与项目兼容性规范.md
 *   skills/<skill-id>/**            (whitelisted files only)
 *   toolkit/config/runtime.example.json, runtime.schema.json
 *   toolkit/contracts/统一接口契约.md
 */

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyInto(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

async function copyDirWhitelisted(
  srcDir: string,
  destDir: string,
  predicate: (relPath: string) => boolean,
  copied: string[],
): Promise<void> {
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = abs.slice(srcDir.length + 1).split(sep).join('/');
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile() && predicate(rel)) {
        await copyInto(abs, join(destDir, rel));
        copied.push(rel);
      }
    }
  }
  if (await pathExists(srcDir)) await walk(srcDir);
}

export interface SnapshotResult {
  /** Skill ids discovered from the source manifest. */
  skillIds: string[];
  /** All destination-relative file paths written (posix). */
  writtenFiles: string[];
}

/**
 * Read and parse the source manifest (skills/bundle.manifest.json).
 */
export async function readSourceManifest(sourceDir: string): Promise<BundleManifest> {
  const manifestPath = join(sourceDir, 'skills', 'bundle.manifest.json');
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as BundleManifest;
}

/**
 * Materialize the whitelisted snapshot into `destination`.
 * Returns the list of written destination-relative paths.
 */
export async function materializeSnapshot(
  sourceDir: string,
  destination: string,
  manifest: BundleManifest,
): Promise<SnapshotResult> {
  const written: string[] = [];
  const skillsSrc = join(sourceDir, 'skills');
  const skillsDest = join(destination, 'skills');

  // Bundle-level common files.
  for (const f of BUNDLE_COMMON_FILES) {
    const src = join(skillsSrc, f);
    if (await pathExists(src)) {
      await copyInto(src, join(skillsDest, f));
      written.push(`skills/${f}`);
    }
  }

  // Each skill, whitelisted.
  const skillIds: string[] = [];
  for (const skill of manifest.skills) {
    skillIds.push(skill.id);
    const local: string[] = [];
    await copyDirWhitelisted(
      join(skillsSrc, skill.path),
      join(skillsDest, skill.path),
      isSkillFileIncluded,
      local,
    );
    for (const rel of local) written.push(`skills/${skill.path}/${rel}`);
  }

  // Toolkit files.
  for (const rel of TOOLKIT_FILES) {
    const src = join(sourceDir, rel);
    if (await pathExists(src)) {
      await copyInto(src, join(destination, rel));
      written.push(rel);
    }
  }

  return { skillIds, writtenFiles: written.sort() };
}
