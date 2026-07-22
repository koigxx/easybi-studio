import { describe, it, expect } from 'vitest';
import { allTables, filterTables, extractFields, extractHeader } from './knowledge-view.js';
import type { CatalogOverview, TableOverview, Tier } from '../api.js';

function t(
  over: Partial<TableOverview> & { table: string; tier: Tier; database?: string },
): TableOverview {
  const database = over.database ?? 'db';
  return {
    tableId: `p/${database}/${over.table}`,
    profileId: 'p',
    database,
    table: over.table,
    tier: over.tier,
    name: over.name ?? null,
    comment: over.comment ?? null,
    estimatedRows: null,
    fieldCount: null,
    overrideSource: null,
  };
}

const OVERVIEW: CatalogOverview = {
  kind: 'draft',
  id: 'd1',
  status: 'draft',
  system: null,
  counts: null,
  databases: [
    { profileId: 'p', database: 'db', tables: [t({ table: 'orders', tier: 'hot', name: '订单' })] },
    {
      profileId: 'p',
      database: 'db2',
      tables: [t({ table: 'logs', tier: 'cold', comment: '日志', database: 'db2' })],
    },
  ],
};

describe('allTables', () => {
  it('flattens across databases', () => {
    expect(allTables(OVERVIEW).map((x) => x.table)).toEqual(['orders', 'logs']);
    expect(allTables(null)).toEqual([]);
  });
});

describe('filterTables', () => {
  const tables = allTables(OVERVIEW);
  it('filters by tier', () => {
    const r = filterTables(tables, { tiers: new Set<Tier>(['hot']), query: '', database: null });
    expect(r.map((x) => x.table)).toEqual(['orders']);
  });
  it('filters by query across table/name/comment', () => {
    expect(
      filterTables(tables, { tiers: new Set<Tier>(['hot', 'warm', 'cold']), query: '订单', database: null }),
    ).toHaveLength(1);
    expect(
      filterTables(tables, { tiers: new Set<Tier>(['hot', 'warm', 'cold']), query: '日志', database: null }),
    ).toHaveLength(1);
    expect(
      filterTables(tables, { tiers: new Set<Tier>(['hot', 'warm', 'cold']), query: 'xyz', database: null }),
    ).toHaveLength(0);
  });
  it('filters by database', () => {
    const r = filterTables(tables, {
      tiers: new Set<Tier>(['hot', 'warm', 'cold']),
      query: '',
      database: 'p/db2',
    });
    expect(r.map((x) => x.table)).toEqual(['logs']);
  });
});

describe('extractFields', () => {
  it('flattens physical/semantic/filter into rows', () => {
    const rows = extractFields({
      physical_fields: [
        {
          physical: { name: 'id', native_type: 'bigint(20)', primary_key: true, nullable: false, comment: '主键' },
          semantic: { name: 'ID', description: '标识', report_exposed: true },
          filter: { enabled: true, role: 'business_identifier', default_operator: 'eq' },
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'id',
      dataType: 'bigint(20)',
      primaryKey: true,
      semanticName: 'ID',
      reportExposed: true,
      filterEnabled: true,
      filterRole: 'business_identifier',
      defaultOperator: 'eq',
    });
  });
  it('returns [] when no fields', () => {
    expect(extractFields({})).toEqual([]);
  });
});

describe('extractHeader', () => {
  it('reads business identity, override, activity', () => {
    const h = extractHeader({
      comment: '表注释',
      estimated_rows: 100,
      business: { name: '业务名', description: '描述', domain: '订单' },
      classification: { override: { source: 'user', reason: '提为热表' } },
      activity: { status: 'observed', field: 'create_time', last_data_at: '2026-07-17' },
    });
    expect(h.name).toBe('业务名');
    expect(h.domain).toBe('订单');
    expect(h.estimatedRows).toBe(100);
    expect(h.overrideReason).toBe('提为热表');
    expect(h.activityNote).toContain('observed');
  });
});
