import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyTablePatch,
  updateByFieldIndex,
  writeTableSemantics,
  readTableFileRaw,
  CatalogConflictError,
} from './knowledge-edit.js';

const TABLE = {
  table_id: 'p/db/orders',
  tier: 'hot',
  comment: '订单表',
  business: { name: '订单', description: null, status: 'inferred', source: 'table_comment' },
  physical_fields: [
    {
      physical: { name: 'id', native_type: 'bigint(20)', primary_key: true },
      semantic: { name: 'ID', description: null, report_exposed: false, status: 'inferred' },
      filter: { enabled: true, role: 'business_identifier', default_operator: 'eq', status: 'inferred' },
    },
    {
      physical: { name: 'amount', native_type: 'decimal(10,2)' },
      semantic: { name: '金额', report_exposed: false, status: 'inferred' },
      filter: { enabled: false, status: 'inferred' },
    },
  ],
};

describe('applyTablePatch', () => {
  it('edits table business identity and marks confirmed', () => {
    const next = applyTablePatch(TABLE, { name: '销售订单', domain: '订单域' });
    const b = next.business as Record<string, unknown>;
    expect(b.name).toBe('销售订单');
    expect(b.domain).toBe('订单域');
    expect(b.status).toBe('confirmed');
    expect(b.source).toBe('user');
  });

  it('edits a field semantic + filter and marks confirmed', () => {
    const next = applyTablePatch(TABLE, {
      fields: [
        { field: 'amount', name: '订单金额', reportExposed: true, filterEnabled: true, defaultOperator: 'between' },
      ],
    });
    const fields = next.physical_fields as Array<Record<string, unknown>>;
    const amount = fields[1]!;
    const sem = amount.semantic as Record<string, unknown>;
    const flt = amount.filter as Record<string, unknown>;
    expect(sem.name).toBe('订单金额');
    expect(sem.report_exposed).toBe(true);
    expect(sem.status).toBe('confirmed');
    expect(flt.enabled).toBe(true);
    expect(flt.default_operator).toBe('between');
    expect(flt.status).toBe('confirmed');
  });

  it('does not touch physical schema or other fields', () => {
    const next = applyTablePatch(TABLE, { fields: [{ field: 'amount', name: 'x' }] });
    const fields = next.physical_fields as Array<Record<string, unknown>>;
    expect((fields[0]!.physical as Record<string, unknown>).name).toBe('id');
    expect((fields[0]!.semantic as Record<string, unknown>).name).toBe('ID'); // untouched
    expect((fields[1]!.physical as Record<string, unknown>).native_type).toBe('decimal(10,2)');
  });

  it('does not mutate the input', () => {
    const input = structuredClone(TABLE);
    applyTablePatch(input, { name: 'zzz' });
    expect((input.business as Record<string, unknown>).name).toBe('订单');
  });
});

describe('updateByFieldIndex', () => {
  it('replaces only the edited table entries, keeps others', () => {
    const index = {
      fields: [
        { table_id: 'p/db/other', field: 'x', semantic_name: 'X', tier: 'warm' },
        { table_id: 'p/db/orders', field: 'id', semantic_name: 'OLD', tier: 'hot' },
      ],
    };
    const next = applyTablePatch(TABLE, { fields: [{ field: 'id', name: '新ID' }] });
    const updated = updateByFieldIndex(index, 'p/db/orders', 'hot', next);
    const other = updated.fields.filter((f) => f.table_id === 'p/db/other');
    const orders = updated.fields.filter((f) => f.table_id === 'p/db/orders');
    expect(other).toHaveLength(1);
    expect(other[0]!.semantic_name).toBe('X');
    expect(orders.map((f) => f.field).sort()).toEqual(['amount', 'id']);
    expect(orders.find((f) => f.field === 'id')!.semantic_name).toBe('新ID');
  });
});

async function makeDraft(): Promise<{ ws: string; draftId: string }> {
  const ws = await mkdtemp(join(tmpdir(), 'easybi-ke-'));
  const draftId = 'draft-1';
  const dbDir = join(ws, 'knowledge', 'drafts', draftId, 'databases', 'p', 'db');
  await mkdir(join(dbDir, 'hot', 'tables'), { recursive: true });
  await mkdir(join(ws, 'knowledge', 'drafts', draftId, 'indexes'), { recursive: true });
  await writeFile(join(dbDir, 'hot', 'tables', 'orders.json'), JSON.stringify(TABLE, null, 2) + '\n');
  await writeFile(
    join(ws, 'knowledge', 'drafts', draftId, 'indexes', 'by-field.json'),
    JSON.stringify({
      fields: [{ table_id: 'p/db/orders', field: 'id', semantic_name: 'ID', tier: 'hot' }],
    }),
  );
  return { ws, draftId };
}

describe('writeTableSemantics (round-trip)', () => {
  it('writes edits, backs up, syncs by-field index', async () => {
    const { ws, draftId } = await makeDraft();
    try {
      const before = await readTableFileRaw(ws, draftId, 'p/db/orders');
      expect(before).not.toBeNull();

      const res = await writeTableSemantics({
        workspaceRoot: ws,
        draftId,
        tableId: 'p/db/orders',
        patch: { fields: [{ field: 'amount', name: '订单金额' }] },
        expectedRevision: before!.revision,
      });
      expect(res.tier).toBe('hot');
      expect(res.backupPath).toContain('knowledge-backups');

      const after = await readTableFileRaw(ws, draftId, 'p/db/orders');
      const fields = after!.data.physical_fields as Array<Record<string, unknown>>;
      expect((fields[1]!.semantic as Record<string, unknown>).name).toBe('订单金额');

      const idx = JSON.parse(
        await readFile(join(ws, 'knowledge', 'drafts', draftId, 'indexes', 'by-field.json'), 'utf8'),
      ) as { fields: Array<{ field: string; semantic_name: string }> };
      expect(idx.fields.find((f) => f.field === 'amount')!.semantic_name).toBe('订单金额');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('rejects a stale revision', async () => {
    const { ws, draftId } = await makeDraft();
    try {
      await expect(
        writeTableSemantics({
          workspaceRoot: ws,
          draftId,
          tableId: 'p/db/orders',
          patch: { name: 'x' },
          expectedRevision: 'deadbeef',
        }),
      ).rejects.toBeInstanceOf(CatalogConflictError);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('404s for a cold/unknown table (no file)', async () => {
    const { ws, draftId } = await makeDraft();
    try {
      await expect(
        writeTableSemantics({
          workspaceRoot: ws,
          draftId,
          tableId: 'p/db/ghost',
          patch: { name: 'x' },
          expectedRevision: 'x',
        }),
      ).rejects.toThrow(/未找到/);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
