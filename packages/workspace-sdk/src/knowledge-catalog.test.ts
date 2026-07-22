import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listCatalogs,
  readCatalogOverview,
  readTableDetail,
  splitTableId,
} from './knowledge-catalog.js';

async function makeWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'easybi-kc-'));
  const draft = join(ws, 'knowledge', 'drafts', 'draft-1');
  const dbDir = join(draft, 'databases', 'p1', 'db1');
  await mkdir(join(dbDir, 'hot', 'tables'), { recursive: true });
  await mkdir(join(dbDir, 'warm', 'tables'), { recursive: true });
  await mkdir(join(dbDir, 'cold'), { recursive: true });
  await mkdir(join(draft, 'indexes'), { recursive: true });
  await mkdir(join(ws, 'knowledge', 'versions', '1.0.0', 'indexes'), { recursive: true });

  await writeFile(
    join(draft, 'manifest.json'),
    JSON.stringify({
      catalog_status: 'draft',
      generated_at: '2026-07-19T00:00:00Z',
      system: { id: 'sys1', name: '系统一' },
      counts: { total: 3, hot: 1, warm: 1, cold: 1 },
    }),
  );
  await writeFile(
    join(draft, 'indexes', 'by-tier.json'),
    JSON.stringify({
      hot: ['p1/db1/hot_table'],
      warm: ['p1/db1/warm_table'],
      cold: ['p1/db1/cold_table'],
    }),
  );
  await writeFile(
    join(dbDir, 'hot', 'tables', 'hot_table.json'),
    JSON.stringify({
      table_id: 'p1/db1/hot_table',
      tier: 'hot',
      comment: '热表注释',
      estimated_rows: 100,
      business: { name: '热表业务名' },
      classification: { override: { source: 'user', reason: 'r' } },
      physical_fields: [{ physical: { name: 'id' }, semantic: { name: 'ID' } }],
    }),
  );
  await writeFile(
    join(dbDir, 'warm', 'tables', 'warm_table.json'),
    JSON.stringify({
      table_id: 'p1/db1/warm_table',
      tier: 'warm',
      comment: '温表',
      estimated_rows: 50,
      business: { name: null },
      classification: { override: null },
      physical_fields: [{ physical: { name: 'a' }, semantic: { name: 'A' } }],
    }),
  );
  await writeFile(
    join(dbDir, 'cold', 'tables.json'),
    JSON.stringify({
      tables: [
        {
          table_id: 'p1/db1/cold_table',
          tier: 'cold',
          comment: '冷表',
          estimated_rows: 5,
          business: {},
          classification: { override: null },
        },
      ],
    }),
  );

  // Published version 1.0.0 (minimal, current)
  await writeFile(
    join(ws, 'knowledge', 'versions', '1.0.0', 'manifest.json'),
    JSON.stringify({ catalog_status: 'published', counts: { total: 3, hot: 1, warm: 1, cold: 1 } }),
  );
  await writeFile(
    join(ws, 'knowledge', 'versions', '1.0.0', 'indexes', 'by-tier.json'),
    JSON.stringify({ hot: [], warm: [], cold: [] }),
  );
  await writeFile(join(ws, 'knowledge', 'index.json'), JSON.stringify({ current_version: '1.0.0' }));

  return ws;
}

describe('splitTableId', () => {
  it('splits profile/database/table', () => {
    expect(splitTableId('p1/db1/t')).toEqual({ profileId: 'p1', database: 'db1', table: 't' });
  });
});

describe('listCatalogs', () => {
  it('lists drafts and versions with counts, marks current', async () => {
    const ws = await makeWorkspace();
    try {
      const list = await listCatalogs(ws);
      expect(list.drafts).toHaveLength(1);
      expect(list.drafts[0]!.status).toBe('draft');
      expect(list.drafts[0]!.counts).toEqual({ total: 3, hot: 1, warm: 1, cold: 1 });
      expect(list.latestDraftId).toBe('draft-1');
      expect(list.currentVersion).toBe('1.0.0');
      expect(list.versions[0]!.isCurrent).toBe(true);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('readCatalogOverview', () => {
  it('groups tables by database with tier + override + field counts', async () => {
    const ws = await makeWorkspace();
    try {
      const ov = await readCatalogOverview(ws, 'draft', 'draft-1');
      expect(ov).not.toBeNull();
      expect(ov!.databases).toHaveLength(1);
      const g = ov!.databases[0]!;
      expect(g.profileId).toBe('p1');
      expect(g.database).toBe('db1');
      // hot sorts before warm before cold
      expect(g.tables.map((t) => t.tier)).toEqual(['hot', 'warm', 'cold']);
      const hot = g.tables[0]!;
      expect(hot.name).toBe('热表业务名');
      expect(hot.fieldCount).toBe(1);
      expect(hot.overrideSource).toBe('user');
      const cold = g.tables[2]!;
      expect(cold.fieldCount).toBeNull();
      expect(cold.comment).toBe('冷表');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('returns null for a missing catalog', async () => {
    const ws = await makeWorkspace();
    try {
      expect(await readCatalogOverview(ws, 'draft', 'nope')).toBeNull();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('readTableDetail', () => {
  it('reads a hot table with fields', async () => {
    const ws = await makeWorkspace();
    try {
      const d = await readTableDetail(ws, 'draft', 'draft-1', 'p1/db1/hot_table');
      expect(d).not.toBeNull();
      expect(d!.tier).toBe('hot');
      expect(d!.hasFields).toBe(true);
      expect(Array.isArray(d!.data.physical_fields)).toBe(true);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('reads a cold table entry without fields', async () => {
    const ws = await makeWorkspace();
    try {
      const d = await readTableDetail(ws, 'draft', 'draft-1', 'p1/db1/cold_table');
      expect(d!.tier).toBe('cold');
      expect(d!.hasFields).toBe(false);
      expect(d!.data.comment).toBe('冷表');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('returns null for unknown table', async () => {
    const ws = await makeWorkspace();
    try {
      expect(await readTableDetail(ws, 'draft', 'draft-1', 'p1/db1/ghost')).toBeNull();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
