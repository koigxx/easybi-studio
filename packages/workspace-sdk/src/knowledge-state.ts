import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAbsolute } from './paths.js';

/** Knowledge-base status read from disk facts (plan §10.3). */
export interface KnowledgeState {
  scans: string[];
  drafts: string[];
  publishedVersions: string[];
  currentVersion: string | null;
  /** Counts derived from the latest draft's reviews, when present. */
  hotTables?: number;
  warmTables?: number;
  coldTables?: number;
  enumReviewStatus?: string;
  blockingIssues: number;
  notes: string[];
}

async function listDirs(p: string): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function readJson(p: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readKnowledgeState(workspaceRoot: string): Promise<KnowledgeState> {
  const root = normalizeAbsolute(workspaceRoot);
  const notes: string[] = [];

  const scans = await listDirs(join(root, 'knowledge', 'scans'));
  const drafts = await listDirs(join(root, 'knowledge', 'drafts'));
  const publishedVersions = await listDirs(join(root, 'knowledge', 'versions'));

  const index = (await readJson(join(root, 'knowledge', 'index.json'))) as
    | { current_version?: string | null }
    | null;
  const currentVersion = index?.current_version ?? null;

  const state: KnowledgeState = {
    scans,
    drafts,
    publishedVersions,
    currentVersion,
    blockingIssues: 0,
    notes,
  };

  // Inspect the latest draft's reviews for counts and blocking issues.
  const latestDraft = drafts[drafts.length - 1];
  if (latestDraft) {
    const draftDir = join(root, 'knowledge', 'drafts', latestDraft);
    const blocking = (await readJson(join(draftDir, 'reviews', 'blocking-issues.json'))) as
      | { issues?: unknown[] }
      | null;
    if (blocking && Array.isArray(blocking.issues)) state.blockingIssues = blocking.issues.length;

    const enumReview = (await readJson(join(draftDir, 'reviews', 'enum-review.json'))) as
      | { status?: string }
      | null;
    if (enumReview?.status) state.enumReviewStatus = enumReview.status;

    // Tier counts from by-tier index when present.
    const byTier = (await readJson(join(draftDir, 'indexes', 'by-tier.json'))) as
      | { hot?: unknown[]; warm?: unknown[]; cold?: unknown[] }
      | null;
    if (byTier) {
      if (Array.isArray(byTier.hot)) state.hotTables = byTier.hot.length;
      if (Array.isArray(byTier.warm)) state.warmTables = byTier.warm.length;
      if (Array.isArray(byTier.cold)) state.coldTables = byTier.cold.length;
    }
  }

  if (drafts.length === 0 && publishedVersions.length === 0) {
    notes.push('尚无知识库草稿或已发布版本');
  }
  if (!(await exists(join(root, 'knowledge', 'index.json')))) {
    notes.push('缺少 knowledge/index.json');
  }

  return state;
}
