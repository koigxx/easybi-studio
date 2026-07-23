import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReportModel, writeReportModel } from './report-model.js';

let ws: string;

type TestModel = Record<string, unknown> & {
  approval: { status: string; model_hash?: string };
};

function hashModel(model: Record<string, unknown>): string {
  const copy = structuredClone(model);
  delete copy.approval;
  delete copy.generated_at;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-report-model-'));
  await json(join(ws, 'skills', 'bundle.manifest.json'), {
    workspace_contract: {
      paths: {
        report_models: 'reports/models',
        report_plans: 'reports/plans',
      },
    },
  });
  const knowledge = join(ws, 'knowledge', 'versions', '1.0.0');
  await json(join(knowledge, 'databases', 'main', 'driver.json'), {
    table_id: 'driver',
    physical: { profile_id: 'p1', database: 'main', table: 'driver' },
    physical_fields: [
      { physical: { name: 'id' }, semantic: { name: '司机 ID' } },
      { physical: { name: 'customer_id' }, semantic: { name: '客户 ID' } },
      { physical: { name: 'name' }, semantic: { name: '司机姓名' } },
    ],
  });
  await json(join(knowledge, 'databases', 'main', 'customer.json'), {
    table_id: 'customer',
    physical: { profile_id: 'p1', database: 'main', table: 'customer' },
    physical_fields: [
      { physical: { name: 'id' }, semantic: { name: '客户 ID' } },
      { physical: { name: 'name' }, semantic: { name: '客户名称' } },
    ],
  });
  const root = join(ws, 'reports', 'models', 'r1');
  const model: TestModel = {
    model_format_version: '1',
    generated_at: '2026-01-01T00:00:00.000Z',
    report: { id: 'r1', name: '报表一' },
    result_grain: { description: '一行一个司机', keys: ['id'] },
    sources: [
      {
        id: 't0',
        profile_id: 'p1',
        database: 'main',
        table: 'driver',
        alias: 't0',
        fields: [
          { name: 'id', role: 'source' },
          { name: 'customer_id', role: 'source' },
        ],
      },
      {
        id: 't1',
        profile_id: 'p1',
        database: 'main',
        table: 'customer',
        alias: 't1',
        fields: [{ name: 'id', role: 'source' }],
      },
    ],
    relationships: [
      { from: 't0.customer_id', to: 't1.id', type: 'left', cardinality: 'n:1' },
    ],
    metrics: [],
    filters: [],
    recommended_strategy: 'sql',
    query_contracts: [
      {
        id: 'main',
        result_grain: '一行一个司机',
        sources: [
          { profile_id: 'p1', database: 'main', table: 'driver', fields: ['id', 'customer_id'] },
          { profile_id: 'p1', database: 'main', table: 'customer', fields: ['id'] },
        ],
        output: [{ name: 'id', type: 'string' }],
      },
    ],
    open_questions: [],
    approval: { status: 'draft' },
  };
  model.approval = { status: 'approved', model_hash: hashModel(model) };
  await json(join(root, 'report-model.json'), model);
  await json(join(root, 'source.lock.json'), {
    knowledge: { source_dir: knowledge },
    model_hash: model.approval.model_hash,
    tables: [
      {
        table_id: 'driver',
        physical: { profile_id: 'p1', database: 'main', table: 'driver' },
        fields: [
          { physical: { name: 'id' } },
          { physical: { name: 'customer_id' } },
        ],
      },
      {
        table_id: 'customer',
        physical: { profile_id: 'p1', database: 'main', table: 'customer' },
        fields: [{ physical: { name: 'id' } }],
      },
    ],
  });
  await json(join(root, 'model.manifest.json'), {
    status: 'approved',
    model_hash: model.approval.model_hash,
  });
  await writeFile(join(root, 'checksums.sha256'), '');
  await json(join(ws, 'reports', 'plans', 'r1.json'), { report: { id: 'r1' } });
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('current report model', () => {
  it('reads available knowledge fields while keeping the package minimal', async () => {
    const detail = await readReportModel(ws, 'r1');
    expect(detail.status).toBe('approved');
    expect(detail.sources[0]?.fields.find((field) => field.name === 'name')?.selected).toBe(false);
  });

  it('edits fields and relationships, approves the model, and updates its minimal source lock', async () => {
    const detail = await readReportModel(ws, 'r1');
    const saved = await writeReportModel(ws, 'r1', {
      expectedRevision: detail.revision,
      reviewedBy: 'tester',
      sources: [
        {
          id: 't0',
          fields: [
            { name: 'id' },
            { name: 'customer_id' },
            { name: 'name' },
          ],
        },
        { id: 't1', fields: [{ name: 'id' }] },
      ],
      relationships: [
        { from: 't0.customer_id', to: 't1.id', type: 'left', cardinality: 'n:1' },
      ],
    });
    expect(saved.status).toBe('approved');
    expect(saved.revision).not.toBe(detail.revision);
    const lock = JSON.parse(
      await readFile(join(ws, 'reports', 'models', 'r1', 'source.lock.json'), 'utf8'),
    ) as { tables: Array<{ fields: Array<{ physical: { name: string } }> }> };
    expect(lock.tables[0]?.fields.map((field) => field.physical.name)).toContain('name');
    const plan = JSON.parse(
      await readFile(join(ws, 'reports', 'plans', 'r1.json'), 'utf8'),
    ) as { report_model: { model_hash: string } };
    expect(plan.report_model.model_hash).toBe(saved.modelHash);
  });

  it('rejects stale revisions and relationship endpoints outside selected fields', async () => {
    const detail = await readReportModel(ws, 'r1');
    await expect(
      writeReportModel(ws, 'r1', {
        expectedRevision: 'stale',
        reviewedBy: 'tester',
        sources: [],
        relationships: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      writeReportModel(ws, 'r1', {
        expectedRevision: detail.revision,
        reviewedBy: 'tester',
        sources: [
          { id: 't0', fields: [{ name: 'id' }, { name: 'customer_id' }] },
          { id: 't1', fields: [{ name: 'id' }] },
        ],
        relationships: [
          { from: 't0.name', to: 't1.id', type: 'left', cardinality: 'n:1' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });
});
