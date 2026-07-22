import { describe, it, expect } from 'vitest';
import {
  shortTable,
  bindingRows,
  dictionaryNames,
  dictionaryByName,
  completeness,
  renameDictionary,
  rebindDictionary,
  setDictionaryValues,
} from './enums-view.js';
import type { EnumsDocument } from '../api.js';

const DOC: EnumsDocument = {
  schema_version: '2',
  dictionaries: [
    {
      name: '订单状态',
      values: [
        { value: 'FINISHED', label: '已完成', description: '' },
        { value: 'CANCELED', label: '', description: '' },
      ],
    },
    { name: '类型', values: [] },
  ],
  bindings: [
    { table_id: 'p/db/oms_order', field: 'status', dictionary_name: '订单状态' },
    { table_id: 'p/db/oms_waybill', field: 'wb_status', dictionary_name: '订单状态' },
    { table_id: 'p/db/oms_order', field: 'type', dictionary_name: '类型' },
  ],
};

describe('shortTable', () => {
  it('takes the last path segment', () => {
    expect(shortTable('p/db/oms_order')).toBe('oms_order');
    expect(shortTable('x')).toBe('x');
  });
});

describe('bindingRows', () => {
  it('derives connection/db/table from table_id when not enriched', () => {
    const rows = bindingRows(DOC);
    expect(rows).toHaveLength(3);
    const r = rows.find((x) => x.field === 'status')!;
    expect(r.profileId).toBe('p');
    expect(r.database).toBe('db');
    expect(r.table).toBe('oms_order');
    expect(r.note).toBe('');
  });

  it('prefers service-enriched fields (profileId/database/table/note)', () => {
    const enriched = bindingRows({
      dictionaries: [],
      bindings: [
        {
          table_id: 'prof/mydb/mytable',
          field: 'status',
          dictionary_name: 'D',
          profileId: 'prof',
          database: 'mydb',
          table: 'mytable',
          note: '订单状态',
        },
      ],
    });
    expect(enriched[0]).toMatchObject({
      profileId: 'prof',
      database: 'mydb',
      table: 'mytable',
      note: '订单状态',
    });
  });
});

describe('dictionaryNames', () => {
  it('returns distinct referenced names (locale-sorted)', () => {
    expect(dictionaryNames(DOC).sort()).toEqual(['订单状态', '类型'].sort());
    expect(dictionaryNames(DOC)).toHaveLength(2);
  });
});

describe('dictionaryByName', () => {
  it('returns the dict or a synthesized empty one', () => {
    expect(dictionaryByName(DOC, '订单状态').values).toHaveLength(2);
    expect(dictionaryByName(DOC, '不存在')).toEqual({ name: '不存在', values: [] });
  });
});

describe('completeness', () => {
  it('counts value/label pairs that are both filled', () => {
    expect(completeness(dictionaryByName(DOC, '订单状态'))).toEqual({ total: 2, filled: 1 });
    expect(completeness(dictionaryByName(DOC, '类型'))).toEqual({ total: 0, filled: 0 });
  });
});

describe('renameDictionary', () => {
  it('renames the dictionary and all its bindings', () => {
    const next = renameDictionary(DOC, '订单状态', '订单状态-v2');
    expect(next.dictionaries.some((d) => d.name === '订单状态-v2')).toBe(true);
    expect(next.dictionaries.some((d) => d.name === '订单状态')).toBe(false);
    expect(next.bindings.filter((b) => b.dictionary_name === '订单状态-v2')).toHaveLength(2);
  });

  it('merges into an existing target (drops the source dict, repoints bindings)', () => {
    const next = renameDictionary(DOC, '类型', '订单状态');
    expect(next.dictionaries.filter((d) => d.name === '订单状态')).toHaveLength(1);
    expect(next.dictionaries.some((d) => d.name === '类型')).toBe(false);
    expect(next.bindings.every((b) => b.dictionary_name === '订单状态')).toBe(true);
  });

  it('merges source-only codes without overwriting target labels', () => {
    const value = {
      ...DOC,
      dictionaries: [
        {
          name: '订单状态',
          values: [{ value: 'DONE', label: '已完成' }],
        },
        {
          name: '类型',
          values: [
            { value: 'DONE', label: '旧标签' },
            { value: 'NEW', label: '新增' },
          ],
        },
      ],
    };
    const next = renameDictionary(value, '类型', '订单状态');
    const values = dictionaryByName(next, '订单状态').values;
    expect(values).toEqual([
      { value: 'DONE', label: '已完成' },
      { value: 'NEW', label: '新增' },
    ]);
  });

  it('no-op on empty or unchanged name', () => {
    expect(renameDictionary(DOC, '订单状态', '  ')).toBe(DOC);
    expect(renameDictionary(DOC, '订单状态', '订单状态')).toBe(DOC);
  });
});

describe('rebindDictionary', () => {
  it('splits one field into a new empty dictionary without changing other bindings', () => {
    const next = rebindDictionary(DOC, 'p/db/oms_order', 'status', '订单状态-主表');
    expect(
      next.bindings.find((b) => b.table_id === 'p/db/oms_order' && b.field === 'status')
        ?.dictionary_name,
    ).toBe('订单状态-主表');
    expect(
      next.bindings.find((b) => b.table_id === 'p/db/oms_waybill')?.dictionary_name,
    ).toBe('订单状态');
    expect(dictionaryByName(next, '订单状态-主表').values).toEqual([]);
  });
});

describe('setDictionaryValues', () => {
  it('replaces values immutably', () => {
    const next = setDictionaryValues(DOC, '订单状态', [{ value: 'X', label: 'x' }]);
    expect(dictionaryByName(next, '订单状态').values).toEqual([{ value: 'X', label: 'x' }]);
    // original unchanged
    expect(dictionaryByName(DOC, '订单状态').values).toHaveLength(2);
  });

  it('creates the dictionary if absent', () => {
    const next = setDictionaryValues(DOC, '新枚举', [{ value: 'A', label: '甲' }]);
    expect(dictionaryByName(next, '新枚举').values).toHaveLength(1);
  });
});
