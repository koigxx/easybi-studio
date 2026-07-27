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
  it('returns only model-selected fields (not all knowledge fields)', async () => {
    const detail = await readReportModel(ws, 'r1');
    expect(detail.status).toBe('approved');
    const names = detail.sources[0]?.fields.map((field) => field.name) ?? [];
    // Only the 2 fields declared in the model source should appear (not all knowledge fields).
    expect(names).toEqual(['customer_id', 'id']);
    for (const field of detail.sources[0]?.fields ?? []) {
      expect(field.selected).toBe(true);
    }
  });

  it('normalizes structured metric lineage and exposes direct query-field lineage', async () => {
    const modelPath = join(ws, 'reports', 'models', 'r1', 'report-model.json');
    const model = JSON.parse(await readFile(modelPath, 'utf8')) as TestModel & {
      metrics: unknown[];
      query_contracts: Array<Record<string, unknown>>;
      output_fields?: unknown[];
    };
    model.metrics = [
      {
        id: 'amount_total',
        label: '金额合计',
        source: { table_alias: 't0', field: 'customer_id' },
        aggregation: 'sum',
        distinct_key: null,
      },
    ];
    model.query_contracts[0]!.output = [
      { name: 'customer_id', label: '客户 ID', type: 'string' },
    ];
    model.query_contracts[0]!.aggregations = [
      { name: 'amount_total', label: '金额合计', type: 'decimal' },
    ];
    model.output_fields = [
      { id: 'customer_id', label: '客户 ID', kind: 'data', route: 'query', query_id: 'main', query_column: 'customer_id', type: 'string' },
      { id: 'amount_total', label: '金额合计', kind: 'metric', route: 'query', query_id: 'main', query_column: 'amount_total', type: 'decimal' },
    ];
    model.approval = { status: 'approved', model_hash: hashModel(model) };
    await json(modelPath, model);

    const detail = await readReportModel(ws, 'r1');
    expect(detail.metrics[0]).toMatchObject({
      sourceAlias: 't0',
      sourceField: 'customer_id',
      dedupKey: '',
    });
    expect(detail.queryContracts[0]?.outputColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'customer_id', role: 'group_key', source: 't0.customer_id' }),
      expect.objectContaining({ name: 'amount_total', role: 'metric', source: 't0.customer_id' }),
    ]));
    expect(detail.outputFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'customer_id', queryColumn: 'customer_id', source: 't0.customer_id' }),
      expect.objectContaining({ id: 'amount_total', queryColumn: 'amount_total', source: 't0.customer_id' }),
    ]));
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

  it('accepts a keyless single-row aggregate model consistently with the Skill validator', async () => {
    const modelPath = join(ws, 'reports', 'models', 'r1', 'report-model.json');
    const model = JSON.parse(await readFile(modelPath, 'utf8')) as TestModel & {
      result_grain: { description: string; keys: string[] };
    };
    model.result_grain = { description: '全部数据汇总为一行', keys: [] };
    model.approval = { status: 'approved', model_hash: hashModel(model) };
    await json(modelPath, model);
    const detail = await readReportModel(ws, 'r1');
    expect(detail.status).toBe('approved');
    expect(detail.resultGrain.keys).toEqual([]);
  });

  it('rejects unsupported joins and metric lineage outside the selected whitelist', async () => {
    const detail = await readReportModel(ws, 'r1');
    const sources = [
      { id: 't0', fields: [{ name: 'id' }, { name: 'customer_id' }] },
      { id: 't1', fields: [{ name: 'id' }] },
    ];
    await expect(
      writeReportModel(ws, 'r1', {
        expectedRevision: detail.revision,
        reviewedBy: 'tester',
        sources,
        relationships: [
          { from: 't0.customer_id', to: 't1.id', type: 'full', cardinality: 'n:1' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });

    await expect(
      writeReportModel(ws, 'r1', {
        expectedRevision: detail.revision,
        reviewedBy: 'tester',
        sources,
        relationships: [
          { from: 't0.customer_id', to: 't1.id', type: 'left', cardinality: 'n:1' },
        ],
        metricEdits: [{ id: 'id', sourceAlias: 't0', sourceField: 'missing' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('rejects a new filter whose binding is not a selected model field', async () => {
    const detail = await readReportModel(ws, 'r1');
    await expect(
      writeReportModel(ws, 'r1', {
        expectedRevision: detail.revision,
        reviewedBy: 'tester',
        sources: [
          { id: 't0', fields: [{ name: 'id' }, { name: 'customer_id' }] },
          { id: 't1', fields: [{ name: 'id' }] },
        ],
        relationships: [
          { from: 't0.customer_id', to: 't1.id', type: 'left', cardinality: 'n:1' },
        ],
        filterEdits: [
          {
            id: 'unsafe_filter',
            label: '非法筛选',
            expression: 't0.`missing`',
            clause: 'where',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('persists a structured calculation DAG and exposes it for visual editing', async () => {
    const detail = await readReportModel(ws, 'r1');
    const saved = await writeReportModel(ws, 'r1', {
      expectedRevision: detail.revision,
      reviewedBy: 'tester',
      sources: [
        { id: 't0', fields: [{ name: 'id' }, { name: 'customer_id' }] },
        { id: 't1', fields: [{ name: 'id' }] },
      ],
      relationships: [
        { from: 't0.customer_id', to: 't1.id', type: 'left', cardinality: 'n:1' },
      ],
      calculationGraph: {
        version: '1',
        nodes: [
          {
            id: 'driver_count',
            label: '司机数',
            kind: 'aggregate',
            outputType: 'integer',
            dependencies: [],
            expression: '',
            sourceField: 't0.id',
            aggregation: 'count_distinct',
            condition: '',
            comparisonMode: '',
            comparisonOffset: 1,
            windowFunction: '',
            partitionBy: [],
            orderBy: [],
            frame: '',
            mergeOperation: '',
            joinKeys: [],
            executionHint: 'sql',
            output: true,
            description: '按司机主键去重',
          },
          {
            id: 'driver_count_double',
            label: '司机数两倍',
            kind: 'formula',
            outputType: 'number',
            dependencies: ['driver_count'],
            expression: '{driver_count} * 2',
            sourceField: '',
            aggregation: '',
            condition: '',
            comparisonMode: '',
            comparisonOffset: 1,
            windowFunction: '',
            partitionBy: [],
            orderBy: [],
            frame: '',
            mergeOperation: '',
            joinKeys: [],
            executionHint: 'auto',
            output: true,
            description: '',
          },
          {
            id: 'driver_count_chain',
            label: '司机数环比',
            kind: 'comparison',
            outputType: 'percentage',
            dependencies: ['driver_count'],
            expression: '',
            sourceField: '',
            aggregation: '',
            condition: '',
            comparisonMode: 'chain',
            comparisonOffset: 1,
            windowFunction: '',
            partitionBy: [],
            orderBy: [],
            frame: '',
            mergeOperation: '',
            joinKeys: [],
            executionHint: 'auto',
            output: true,
            description: '',
          },
          {
            id: 'driver_count_rank',
            label: '司机数排名',
            kind: 'window',
            outputType: 'integer',
            dependencies: ['driver_count'],
            expression: '',
            sourceField: '',
            aggregation: '',
            condition: '',
            comparisonMode: '',
            comparisonOffset: 1,
            windowFunction: 'rank',
            partitionBy: ['t0.customer_id'],
            orderBy: ['t0.id desc'],
            frame: '',
            mergeOperation: '',
            joinKeys: [],
            executionHint: 'sql',
            output: true,
            description: '',
          },
          {
            id: 'combined_count',
            label: '组合指标',
            kind: 'merge',
            outputType: 'number',
            dependencies: ['driver_count', 'driver_count_double'],
            expression: '',
            sourceField: '',
            aggregation: '',
            condition: '',
            comparisonMode: '',
            comparisonOffset: 1,
            windowFunction: '',
            partitionBy: [],
            orderBy: [],
            frame: '',
            mergeOperation: 'add',
            joinKeys: ['customer_id'],
            executionHint: 'script',
            output: true,
            description: '',
          },
        ],
      },
    });
    expect(saved.calculationGraph.persisted).toBe(true);
    expect(saved.calculationGraph.nodes.map((node) => node.id)).toEqual([
      'driver_count',
      'driver_count_double',
      'driver_count_chain',
      'driver_count_rank',
      'combined_count',
    ]);
    expect(saved.calculationGraph.nodes[1]?.dependencies).toEqual(['driver_count']);
  });

  it('rejects calculation fields outside the model and dependency cycles', async () => {
    const detail = await readReportModel(ws, 'r1');
    const base = {
      expectedRevision: detail.revision,
      reviewedBy: 'tester',
      sources: [
        { id: 't0', fields: [{ name: 'id' }, { name: 'customer_id' }] },
        { id: 't1', fields: [{ name: 'id' }] },
      ],
      relationships: [
        { from: 't0.customer_id', to: 't1.id', type: 'left', cardinality: 'n:1' },
      ],
    };
    const node = {
      label: '计算',
      outputType: 'number',
      expression: '',
      sourceField: '',
      aggregation: '',
      condition: '',
      comparisonMode: '',
      comparisonOffset: 1,
      windowFunction: '',
      partitionBy: [] as string[],
      orderBy: [] as string[],
      frame: '',
      mergeOperation: '',
      joinKeys: [] as string[],
      executionHint: 'auto' as const,
      output: true,
      description: '',
    };
    await expect(
      writeReportModel(ws, 'r1', {
        ...base,
        calculationGraph: {
          version: '1',
          nodes: [
            {
              ...node,
              id: 'unsafe_count',
              kind: 'aggregate',
              dependencies: [],
              sourceField: 't0.missing',
              aggregation: 'count',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });

    await expect(
      writeReportModel(ws, 'r1', {
        ...base,
        calculationGraph: {
          version: '1',
          nodes: [
            {
              ...node,
              id: 'a',
              kind: 'formula',
              dependencies: ['b'],
              expression: '{b} + 1',
            },
            {
              ...node,
              id: 'b',
              kind: 'formula',
              dependencies: ['a'],
              expression: '{a} + 1',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });
});
