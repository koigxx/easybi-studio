// Pure helpers for the enum config editor. The page model is exactly the
// enums.json shape (bindings + dictionaries); the studio-service passes it to
// the skill CLI (enums-import-json), which owns validation and the write path.
import type { EnumsDocument, EnumBinding, EnumDictionary } from '../api.js';

export interface EnumBindingRow extends EnumBinding {
  profileId: string;
  database: string;
  table: string; // last segment of table_id, for display
  note: string; // 字段说明
}

/** Split "profile/db/table" to a short table name. */
export function shortTable(tableId: string): string {
  const parts = tableId.split('/');
  return parts[parts.length - 1] ?? tableId;
}

/** Normalize a binding into a display row (prefers service-enriched fields). */
function toRow(b: EnumBinding): EnumBindingRow {
  const [p = '', d = '', t = ''] = b.table_id.split('/');
  return {
    ...b,
    profileId: b.profileId ?? p,
    database: b.database ?? d,
    table: b.table ?? t,
    note: b.note ?? '',
  };
}

/** Bindings enriched with connection/db/table/note, sorted by connection→db→table→field. */
export function bindingRows(doc: EnumsDocument): EnumBindingRow[] {
  return [...(doc.bindings ?? [])].map(toRow).sort(
    (a, b) =>
      a.profileId.localeCompare(b.profileId) ||
      a.database.localeCompare(b.database) ||
      a.table.localeCompare(b.table) ||
      a.field.localeCompare(b.field),
  );
}

/** Distinct dictionary names referenced by bindings, sorted. */
export function dictionaryNames(doc: EnumsDocument): string[] {
  return [...new Set((doc.bindings ?? []).map((b) => b.dictionary_name))].sort();
}

/** Look up a dictionary by name (or a synthesized empty one). */
export function dictionaryByName(doc: EnumsDocument, name: string): EnumDictionary {
  return (doc.dictionaries ?? []).find((d) => d.name === name) ?? { name, values: [] };
}

/** How many code→label pairs are complete (both value and label filled). */
export function completeness(dict: EnumDictionary): { total: number; filled: number } {
  const total = dict.values.length;
  const filled = dict.values.filter((v) => v.value.trim() && v.label.trim()).length;
  return { total, filled };
}

/** Rename a dictionary everywhere (bindings + the dictionary entry). Merges if the target exists. */
export function renameDictionary(doc: EnumsDocument, from: string, to: string): EnumsDocument {
  const target = to.trim();
  if (!target || from === target) return doc;
  const bindings = (doc.bindings ?? []).map((b) =>
    b.dictionary_name === from ? { ...b, dictionary_name: target } : b,
  );
  const existingTarget = (doc.dictionaries ?? []).find((d) => d.name === target);
  let dictionaries: EnumDictionary[];
  if (existingTarget) {
    // Merge without losing mappings. Target values and labels win on duplicate
    // codes; source-only codes are appended.
    const source = (doc.dictionaries ?? []).find((d) => d.name === from);
    const targetCodes = new Set(existingTarget.values.map((value) => value.value));
    const merged = {
      ...existingTarget,
      values: [
        ...existingTarget.values,
        ...(source?.values ?? []).filter((value) => !targetCodes.has(value.value)),
      ],
    };
    dictionaries = (doc.dictionaries ?? [])
      .filter((d) => d.name !== from && d.name !== target)
      .concat(merged);
  } else {
    dictionaries = (doc.dictionaries ?? []).map((d) =>
      d.name === from ? { ...d, name: target } : d,
    );
  }
  return { ...doc, bindings, dictionaries };
}

/** Reassign one field binding, enabling dictionary split/merge from the binding table. */
export function rebindDictionary(
  doc: EnumsDocument,
  tableId: string,
  field: string,
  dictionaryName: string,
): EnumsDocument {
  const target = dictionaryName.trim();
  if (!target) return doc;
  const bindings = (doc.bindings ?? []).map((binding) =>
    binding.table_id === tableId && binding.field === field
      ? { ...binding, dictionary_name: target }
      : binding,
  );
  const exists = (doc.dictionaries ?? []).some((dictionary) => dictionary.name === target);
  const dictionaries = exists
    ? doc.dictionaries
    : [...(doc.dictionaries ?? []), { name: target, values: [] }];
  return { ...doc, bindings, dictionaries };
}

/** Add a new binding row. If the dictionary doesn't exist yet, creates an empty one. */
export function addBinding(
  doc: EnumsDocument,
  binding: { table_id: string; field: string; dictionary_name: string; note?: string },
): EnumsDocument {
  const bindings = [...(doc.bindings ?? []), { ...binding }];
  const exists = (doc.dictionaries ?? []).some((d) => d.name === binding.dictionary_name);
  const dictionaries = exists
    ? doc.dictionaries
    : [...(doc.dictionaries ?? []), { name: binding.dictionary_name, values: [] }];
  return { ...doc, bindings, dictionaries };
}

/** Remove a single binding by table_id + field. */
export function removeBinding(
  doc: EnumsDocument,
  tableId: string,
  field: string,
): EnumsDocument {
  const bindings = (doc.bindings ?? []).filter(
    (b) => !(b.table_id === tableId && b.field === field),
  );
  return { ...doc, bindings };
}

/** Replace one dictionary's values (immutably). Creates the dictionary if absent. */
export function setDictionaryValues(
  doc: EnumsDocument,
  name: string,
  values: EnumDictionary['values'],
): EnumsDocument {
  const exists = (doc.dictionaries ?? []).some((d) => d.name === name);
  const dictionaries = exists
    ? (doc.dictionaries ?? []).map((d) => (d.name === name ? { ...d, values } : d))
    : [...(doc.dictionaries ?? []), { name, values }];
  return { ...doc, dictionaries };
}
