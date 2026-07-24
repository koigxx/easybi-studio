import { describe, it, expect } from 'vitest';
import {
  extractReportConfig,
  mergeReportConfig,
  validateReportConfig,
  validateRequirement,
  upsertRequirementIntoConfig,
  buildScopedReportPrompt,
  parseImportedReports,
  applyImport,
  exportReportsJson,
  newField,
  fieldBinding,
  setFieldBinding,
  hasRole,
  toggleRole,
  type ReportConfigDraft,
  type ReportRequirementDraft,
} from './reports-config.js';

const CONFIG = {
  config_version: '4',
  system: { id: 'transport-system' },
  connections: { database_profiles: [{ id: 'a' }] },
  knowledge: {
    inactivity_days: 90,
    report_scenarios: ['运输订单明细', '承运商结算明细'],
    report_requirements: [
      { id: 'transport-order-detail', name: '运输订单明细', required_fields: ['运输订单号', '订单状态'] },
      { id: 'carrier-settlement-detail', name: '承运商结算明细', required_fields: ['结算金额'] },
    ],
  },
};

// The bug scenario: skill upgraded required_fields to objects with a field binding.
const CONFIG_OBJECT_FIELDS = {
  config_version: '4',
  knowledge: {
    report_requirements: [
      {
        id: 'transport-order-detail',
        name: '运输订单明细',
        required_fields: [
          { field: 'oms_main_order_simple.main_order_no', label: '运输订单号' },
          { field: 'oms_main_order_simple.status', label: '订单状态' },
        ],
      },
    ],
  },
};

function texts(d: ReportConfigDraft, i = 0): string[] {
  return d.requirements[i]!.requiredFields.map((f) => f.text);
}

describe('extractReportConfig', () => {
  it('reads string required_fields', () => {
    const d = extractReportConfig(CONFIG);
    expect(d.requirements).toHaveLength(2);
    expect(d.requirements[0]!.id).toBe('transport-order-detail');
    expect(texts(d)).toEqual(['运输订单号', '订单状态']);
    expect(d.requirements[0]!.requiredFields[0]!.raw).toBeUndefined();
    expect(d.scenarios).toEqual(['运输订单明细', '承运商结算明细']);
  });

  it('reads object required_fields using label, preserving the binding', () => {
    const d = extractReportConfig(CONFIG_OBJECT_FIELDS);
    expect(texts(d)).toEqual(['运输订单号', '订单状态']);
    expect(d.requirements[0]!.requiredFields[0]!.raw).toEqual({
      field: 'oms_main_order_simple.main_order_no',
      label: '运输订单号',
    });
  });

  it('never yields "[object Object]" for object fields', () => {
    const d = extractReportConfig(CONFIG_OBJECT_FIELDS);
    expect(texts(d).some((t) => t.includes('[object'))).toBe(false);
  });

  it('tolerates missing knowledge / arrays', () => {
    expect(extractReportConfig({})).toEqual({ requirements: [], scenarios: [] });
    expect(extractReportConfig(null)).toEqual({ requirements: [], scenarios: [] });
    expect(extractReportConfig({ knowledge: {} })).toEqual({ requirements: [], scenarios: [] });
  });
});

describe('mergeReportConfig', () => {
  it('round-trips string fields', () => {
    const d = extractReportConfig(CONFIG);
    const merged = mergeReportConfig(CONFIG, d) as {
      knowledge: { report_requirements: Array<{ required_fields: unknown[] }> };
    };
    expect(merged.knowledge.report_requirements[0]!.required_fields).toEqual(['运输订单号', '订单状态']);
  });

  it('round-trips object fields and keeps the binding (fixes the [object Object] bug)', () => {
    const d = extractReportConfig(CONFIG_OBJECT_FIELDS);
    const merged = mergeReportConfig(CONFIG_OBJECT_FIELDS, d) as {
      knowledge: { report_requirements: Array<{ required_fields: unknown[] }> };
    };
    expect(merged.knowledge.report_requirements[0]!.required_fields).toEqual([
      { field: 'oms_main_order_simple.main_order_no', label: '运输订单号' },
      { field: 'oms_main_order_simple.status', label: '订单状态' },
    ]);
  });

  it('updates an object field label while preserving field binding', () => {
    const d = extractReportConfig(CONFIG_OBJECT_FIELDS);
    d.requirements[0]!.requiredFields[0]!.text = '运单号(改)';
    const merged = mergeReportConfig(CONFIG_OBJECT_FIELDS, d) as {
      knowledge: { report_requirements: Array<{ required_fields: Array<Record<string, unknown>> }> };
    };
    expect(merged.knowledge.report_requirements[0]!.required_fields[0]).toEqual({
      field: 'oms_main_order_simple.main_order_no',
      label: '运单号(改)',
    });
  });

  it('preserves all other config fields', () => {
    const d = extractReportConfig(CONFIG);
    const merged = mergeReportConfig(CONFIG, d) as typeof CONFIG;
    expect(merged.config_version).toBe('4');
    expect(merged.system).toEqual({ id: 'transport-system' });
    expect(merged.connections).toEqual({ database_profiles: [{ id: 'a' }] });
    expect(merged.knowledge.inactivity_days).toBe(90);
  });

  it('applies edits and drops empty string fields (keeps bound object fields)', () => {
    const merged = mergeReportConfig(CONFIG, {
      requirements: [
        {
          id: ' r1 ',
          name: ' 报表1 ',
          description: '',
          requiredFields: [
            { text: 'x', roles: [] },
            { text: '  ', roles: [] },
            newField(),
            { text: '', roles: [], raw: { field: 'db.t.c' } }, // empty label but has binding -> kept
          ],
        },
      ],
      scenarios: ['s1', '', '  '],
    }) as { knowledge: { report_requirements: Array<{ required_fields: unknown[] }>; report_scenarios: unknown[] } };
    expect(merged.knowledge.report_requirements[0]!.required_fields).toEqual([
      'x',
      { field: 'db.t.c', label: '' },
    ]);
    expect(merged.knowledge.report_scenarios).toEqual(['s1']);
  });

  it('does not mutate the input config', () => {
    const input = structuredClone(CONFIG);
    mergeReportConfig(input, { requirements: [], scenarios: [] });
    expect(input.knowledge.report_requirements).toHaveLength(2);
  });
});

describe('field binding helpers', () => {
  it('reads binding from an object field, empty for a string field', () => {
    expect(fieldBinding({ text: '运输订单号', roles: [], raw: { field: 'a.b.c', label: '运输订单号' } })).toBe('a.b.c');
    expect(fieldBinding({ text: '运输订单号', roles: [] })).toBe('');
  });

  it('setting a binding creates an object entry; clearing reverts to string', () => {
    const bound = setFieldBinding({ text: '运输订单号', roles: [] }, ' oms.main.no ');
    expect(bound).toEqual({ text: '运输订单号', roles: [], raw: { field: 'oms.main.no', label: '运输订单号' } });
    const cleared = setFieldBinding(bound, '');
    expect(cleared).toEqual({ text: '运输订单号', roles: [] });
  });

  it('bound field round-trips through merge as an object; unbound as a string', () => {
    const merged = mergeReportConfig(CONFIG, {
      requirements: [
        {
          id: 'r',
          name: 'R',
          description: '',
          requiredFields: [setFieldBinding({ text: '订单号', roles: [] }, 'a.b.c'), { text: '状态', roles: [] }],
        },
      ],
      scenarios: [],
    }) as { knowledge: { report_requirements: Array<{ required_fields: unknown[] }> } };
    expect(merged.knowledge.report_requirements[0]!.required_fields).toEqual([
      { field: 'a.b.c', label: '订单号' },
      '状态',
    ]);
  });
});

describe('validateReportConfig', () => {
  it('accepts valid drafts', () => {
    expect(
      validateReportConfig({
        requirements: [{ id: 'a', name: 'A', description: '', requiredFields: [] }],
        scenarios: [],
      }),
    ).toBeNull();
  });

  it('rejects missing id, missing name, and duplicate id', () => {
    expect(
      validateReportConfig({ requirements: [{ id: '', name: 'A', description: '', requiredFields: [] }], scenarios: [] }),
    ).toMatch(/ID/);
    expect(
      validateReportConfig({ requirements: [{ id: 'a', name: '', description: '', requiredFields: [] }], scenarios: [] }),
    ).toMatch(/名称/);
    expect(
      validateReportConfig({
        requirements: [
          { id: 'a', name: 'A', description: '', requiredFields: [] },
          { id: 'a', name: 'B', description: '', requiredFields: [] },
        ],
        scenarios: [],
      }),
    ).toMatch(/重复/);
  });
});

describe('field roles + description', () => {
  it('reads roles + description from object fields', () => {
    const d = extractReportConfig({
      knowledge: {
        report_requirements: [
          {
            id: 'r',
            name: 'R',
            description: '仅统计签收复核后',
            required_fields: [
              { field: 'a.b.customer', label: '客户', roles: ['output', 'filter', 'group'] },
              '普通字段',
            ],
          },
        ],
      },
    });
    expect(d.requirements[0]!.description).toBe('仅统计签收复核后');
    expect(d.requirements[0]!.requiredFields[0]!.roles).toEqual(['output', 'filter', 'group']);
    expect(d.requirements[0]!.requiredFields[1]!.roles).toEqual([]); // string → output-only
  });

  it('hasRole treats empty roles as output-only', () => {
    expect(hasRole({ text: 'x', roles: [] }, 'output')).toBe(true);
    expect(hasRole({ text: 'x', roles: [] }, 'filter')).toBe(false);
    expect(hasRole({ text: 'x', roles: ['filter'] }, 'filter')).toBe(true);
  });

  it('toggleRole adds/removes and never leaves an empty set', () => {
    let f = newField();
    f = toggleRole(f, 'filter'); // output(implicit)+filter
    expect(f.roles).toEqual(['output', 'filter']);
    f = toggleRole(f, 'output'); // remove output
    expect(f.roles).toEqual(['filter']);
    f = toggleRole(f, 'filter'); // removing last → falls back to output-only
    expect(f.roles).toEqual(['output']);
  });

  it('merge persists roles + description; drops default output-only roles to a plain string', () => {
    const merged = mergeReportConfig(
      { knowledge: {} },
      {
        requirements: [
          {
            id: 'gp',
            name: '毛利明细',
            description: '毛利=应收-各方应付-内部成本',
            requiredFields: [
              setFieldBinding({ text: '客户', roles: ['output', 'filter', 'group'] }, 'otms.o.customer'),
              { text: '仅输出列', roles: ['output'] },
              { text: '无角色也是输出', roles: [] },
            ],
          },
        ],
        scenarios: [],
      },
    ) as { knowledge: { report_requirements: Array<Record<string, unknown>> } };
    const req = merged.knowledge.report_requirements[0]!;
    expect(req.description).toBe('毛利=应收-各方应付-内部成本');
    const fields = req.required_fields as unknown[];
    expect(fields[0]).toEqual({ field: 'otms.o.customer', label: '客户', roles: ['output', 'filter', 'group'] });
    // output-only fields collapse back to plain strings (clean config)
    expect(fields[1]).toBe('仅输出列');
    expect(fields[2]).toBe('无角色也是输出');
  });

  it('reads and persists a per-field description', () => {
    const draft = extractReportConfig({
      knowledge: {
        report_requirements: [
          {
            id: 'gp',
            name: '毛利明细',
            required_fields: [
              { field: 'a.b.qty', label: '订单数总和', description: '订单数量的总和' },
              '客户',
            ],
          },
        ],
      },
    });
    const fields = draft.requirements[0]!.requiredFields;
    expect(fields[0]!.description).toBe('订单数量的总和');
    expect(fields[1]!.description).toBe('');

    // Merge round-trips the description onto the object entry and keeps the
    // plain-string field a plain string (no empty description key added).
    const merged = mergeReportConfig({ knowledge: {} }, draft) as {
      knowledge: { report_requirements: Array<Record<string, unknown>> };
    };
    const out = merged.knowledge.report_requirements[0]!.required_fields as unknown[];
    expect(out[0]).toEqual({
      field: 'a.b.qty',
      label: '订单数总和',
      description: '订单数量的总和',
    });
    expect(out[1]).toBe('客户');
  });

  it('upgrades a plain field to an object when only a description is added', () => {
    const merged = mergeReportConfig(
      { knowledge: {} },
      {
        requirements: [
          {
            id: 'r',
            name: 'R',
            description: '',
            requiredFields: [{ text: '订单数总和', roles: [], description: '订单数量的总和' }],
          },
        ],
        scenarios: [],
      },
    ) as { knowledge: { report_requirements: Array<Record<string, unknown>> } };
    const fields = merged.knowledge.report_requirements[0]!.required_fields as unknown[];
    expect(fields[0]).toEqual({ label: '订单数总和', roles: [], description: '订单数量的总和' });
  });

  it('round-trips an unbound metric intent with its aggregation', () => {
    const draft = extractReportConfig({
      knowledge: {
        report_requirements: [
          {
            id: 'usage',
            name: '系统使用统计',
            required_fields: [
              {
                label: '已完成订单数量',
                roles: ['output', 'metric'],
                aggregation: 'count_distinct',
              },
            ],
          },
        ],
      },
    });
    const metric = draft.requirements[0]!.requiredFields[0]!;
    expect(metric.roles).toEqual(['output', 'metric']);
    expect(metric.aggregation).toBe('count_distinct');
    const merged = mergeReportConfig({ knowledge: {} }, draft) as {
      knowledge: { report_requirements: Array<Record<string, unknown>> };
    };
    expect(merged.knowledge.report_requirements[0]!.required_fields).toEqual([
      {
        label: '已完成订单数量',
        roles: ['output', 'metric'],
        aggregation: 'count_distinct',
      },
    ]);
  });
});

describe('parseImportedReports', () => {
  it('parses the minimal name + fields shape with default output+filter roles', () => {
    const json = JSON.stringify([{ name: '报表一', fields: ['字段甲', '字段乙'] }]);
    const out = parseImportedReports(json);
    expect(out.requirements).toHaveLength(1);
    expect(out.requirements[0]!.requiredFields.map((f) => f.text)).toEqual(['字段甲', '字段乙']);
    // Each plainly-imported field defaults to output + filter (never group).
    expect(out.requirements[0]!.requiredFields[0]!.roles).toEqual(['output', 'filter']);
    expect(out.requirements[0]!.requiredFields[1]!.roles).toEqual(['output', 'filter']);
  });

  it('auto-derives an id from an ASCII name and falls back for Chinese names', () => {
    const out = parseImportedReports(
      JSON.stringify([
        { name: 'Gross Profit', fields: ['a'] },
        { name: '毛利明细', fields: ['b'] },
      ]),
    );
    expect(out.requirements[0]!.id).toBe('gross-profit');
    expect(out.requirements[1]!.id).toBe('report-2');
  });

  it('still accepts required_fields (config shape) as an alias for fields', () => {
    const json = JSON.stringify([
      { id: 'r1', name: '报表一', required_fields: ['字段甲', '字段乙'] },
    ]);
    const out = parseImportedReports(json);
    expect(out.requirements[0]!.id).toBe('r1');
    expect(out.requirements[0]!.requiredFields.map((f) => f.text)).toEqual(['字段甲', '字段乙']);
  });

  it('parses an object with report_requirements + report_scenarios', () => {
    const json = JSON.stringify({
      report_requirements: [{ id: 'r1', name: '报表一', required_fields: [] }],
      report_scenarios: ['场景A'],
    });
    const out = parseImportedReports(json);
    expect(out.requirements).toHaveLength(1);
    expect(out.scenarios).toEqual(['场景A']);
  });

  it('parses a full build config (knowledge.report_requirements)', () => {
    const out = parseImportedReports(JSON.stringify(CONFIG));
    expect(out.requirements).toHaveLength(2);
    expect(out.scenarios).toEqual(['运输订单明细', '承运商结算明细']);
  });

  it('parses a single requirement object', () => {
    const out = parseImportedReports(
      JSON.stringify({ id: 'solo', name: '单个', required_fields: ['x'] }),
    );
    expect(out.requirements).toHaveLength(1);
    expect(out.requirements[0]!.id).toBe('solo');
  });

  it('keeps field roles and bindings from imported objects', () => {
    const json = JSON.stringify([
      {
        id: 'r1',
        name: '报表一',
        required_fields: [{ field: 'db.t.c', label: '金额', roles: ['output', 'filter'] }],
      },
    ]);
    const out = parseImportedReports(json);
    const f = out.requirements[0]!.requiredFields[0]!;
    expect(f.text).toBe('金额');
    expect(f.roles).toEqual(['output', 'filter']);
    expect(fieldBinding(f)).toBe('db.t.c');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseImportedReports('{ not json')).toThrow(/JSON/);
  });

  it('throws when no requirements are found', () => {
    expect(() => parseImportedReports(JSON.stringify({ foo: 'bar' }))).toThrow(/报表需求/);
  });

  it('throws on empty input', () => {
    expect(() => parseImportedReports('   ')).toThrow(/为空/);
  });
});

describe('applyImport', () => {
  const base: ReportConfigDraft = {
    requirements: [
      { id: 'a', name: 'A', description: '', requiredFields: [{ text: 'x', roles: [] }] },
      { id: 'b', name: 'B', description: '', requiredFields: [] },
    ],
    scenarios: ['场景A'],
  };
  const imported = {
    requirements: [
      { id: 'a', name: 'A-new', description: '', requiredFields: [] },
      { id: 'c', name: 'C', description: '', requiredFields: [] },
    ],
    scenarios: ['场景A', '场景B'],
  };

  it('merge: same id overwrites, new id appends, scenarios union', () => {
    const out = applyImport(base, imported, 'merge');
    expect(out.requirements.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(out.requirements.find((r) => r.id === 'a')!.name).toBe('A-new');
    expect(out.scenarios).toEqual(['场景A', '场景B']);
  });

  it('replace: imported set wins outright', () => {
    const out = applyImport(base, imported, 'replace');
    expect(out.requirements.map((r) => r.id)).toEqual(['a', 'c']);
    expect(out.scenarios).toEqual(['场景A', '场景B']);
  });

  it('replace: keeps existing scenarios when imported has none', () => {
    const out = applyImport(base, { requirements: imported.requirements, scenarios: [] }, 'replace');
    expect(out.scenarios).toEqual(['场景A']);
  });
});

describe('exportReportsJson', () => {
  it('round-trips through parseImportedReports', () => {
    const draft = extractReportConfig(CONFIG);
    const json = exportReportsJson(draft);
    const reparsed = parseImportedReports(json);
    expect(reparsed.requirements.map((r) => r.id)).toEqual(
      draft.requirements.map((r) => r.id),
    );
    expect(reparsed.scenarios).toEqual(draft.scenarios);
  });
});

describe('upsertRequirementIntoConfig', () => {
  const edited: ReportRequirementDraft = {
    id: 'transport-order-detail',
    name: '运输订单明细V2',
    description: '仅签收后',
    requiredFields: [{ text: '运输订单号', roles: ['output', 'filter'] }],
  };

  it('overwrites an existing requirement in place, preserving the others and order', () => {
    const out = upsertRequirementIntoConfig(CONFIG, edited) as {
      knowledge: { report_requirements: Array<{ id: string; name: string }> };
    };
    const reqs = out.knowledge.report_requirements;
    expect(reqs.map((r) => r.id)).toEqual(['transport-order-detail', 'carrier-settlement-detail']);
    expect(reqs[0]!.name).toBe('运输订单明细V2');
    // The other requirement is untouched.
    expect(reqs[1]!.name).toBe('承运商结算明细');
  });

  it('appends when the id is new', () => {
    const fresh: ReportRequirementDraft = {
      id: 'new-report',
      name: '新报表',
      description: '',
      requiredFields: [],
    };
    const out = upsertRequirementIntoConfig(CONFIG, fresh) as {
      knowledge: { report_requirements: Array<{ id: string }> };
    };
    expect(out.knowledge.report_requirements.map((r) => r.id)).toEqual([
      'transport-order-detail',
      'carrier-settlement-detail',
      'new-report',
    ]);
  });

  it('matches by originalId so a renamed id relocates the same entry', () => {
    const renamed: ReportRequirementDraft = { ...edited, id: 'renamed-id' };
    const out = upsertRequirementIntoConfig(CONFIG, renamed, 'transport-order-detail') as {
      knowledge: { report_requirements: Array<{ id: string }> };
    };
    expect(out.knowledge.report_requirements.map((r) => r.id)).toEqual([
      'renamed-id',
      'carrier-settlement-detail',
    ]);
  });

  it('preserves other config branches', () => {
    const out = upsertRequirementIntoConfig(CONFIG, edited) as {
      system: { id: string };
      knowledge: { report_scenarios: string[] };
    };
    expect(out.system.id).toBe('transport-system');
    expect(out.knowledge.report_scenarios).toEqual(['运输订单明细', '承运商结算明细']);
  });
});

describe('validateRequirement', () => {
  it('rejects a missing id or name', () => {
    expect(validateRequirement({ id: '', name: 'x', description: '', requiredFields: [] })).toMatch(
      /ID/,
    );
    expect(validateRequirement({ id: 'x', name: '', description: '', requiredFields: [] })).toMatch(
      /名称/,
    );
  });

  it('accepts a valid requirement', () => {
    expect(
      validateRequirement({ id: 'x', name: '报表X', description: '', requiredFields: [] }),
    ).toBeNull();
  });
});

describe('buildScopedReportPrompt', () => {
  it('appends the report id + name scope', () => {
    const out = buildScopedReportPrompt('生成报表包。', { id: 'gp', name: '毛利明细' });
    expect(out).toContain('生成报表包。');
    expect(out).toContain('gp（毛利明细）');
    expect(out).toContain('只执行基础建模');
    expect(out).toContain('一次统一确认');
    expect(out).toContain('不得提前生成 SQL、脚本或报表包');
  });

  it('scopes package generation to the approved current model', () => {
    const out = buildScopedReportPrompt(
      '生成报表。',
      { id: 'gp', name: '毛利明细' },
      'build-report-package',
    );
    expect(out).toContain('只使用该报表已确认的当前模型');
    expect(out).toContain('不得重新建模');
    expect(out).not.toContain('只执行基础建模');
  });

  it('scopes model modification to the existing model', () => {
    const out = buildScopedReportPrompt(
      '修改模型。',
      { id: 'gp', name: '毛利明细' },
      'modify-report-model',
    );
    expect(out).toContain('已有当前模型');
    expect(out).toContain('定向修改');
    expect(out).not.toContain('只执行基础建模');
  });

  it('uses just the id when name equals id or is empty', () => {
    expect(buildScopedReportPrompt('x', { id: 'gp', name: 'gp' })).toContain('报表 gp，');
    expect(buildScopedReportPrompt('x', { id: 'gp', name: '' })).toContain('报表 gp，');
  });
});
