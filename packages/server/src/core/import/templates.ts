/**
 * The mapping for a file that arrives again and again.
 *
 * Stored against `ipy_field.internal_id` rather than the field's name, because
 * names are the thing admins change: "Demand" became "Base Price" here in
 * August, and a template keyed on the name would quietly have mapped that
 * column to nothing.
 */
import { db, type Tx } from '../../db/pool.js';
import type { FieldMeta } from '@ipropy/shared';

export interface ImportTemplate {
  id: string;
  name: string;
  headers: string[];
  /** header → field internal_id */
  mapping: Record<string, string>;
  /** field internal_id → one value for every row */
  staticValues: Record<string, unknown>;
  settings: Record<string, unknown>;
  lastUsedAt: string | null;
  useCount: number;
}

interface Row {
  id: string; name: string; headers: string[];
  mapping: Record<string, string>; static_values: Record<string, unknown>;
  settings: Record<string, unknown>; last_used_at: string | null; use_count: number;
}

const toTemplate = (r: Row): ImportTemplate => ({
  id: r.id, name: r.name, headers: r.headers ?? [], mapping: r.mapping ?? {},
  staticValues: r.static_values ?? {}, settings: r.settings ?? {},
  lastUsedAt: r.last_used_at, useCount: r.use_count,
});

export async function listTemplates(moduleId: string, conn: Tx = db): Promise<ImportTemplate[]> {
  const rows = await conn.query<Row>(
    `SELECT id, name, headers, mapping, static_values, settings, last_used_at, use_count
       FROM ipy_import_template WHERE module_id = $1
      ORDER BY last_used_at DESC NULLS LAST, created_at DESC`, [moduleId]);
  return rows.rows.map(toTemplate);
}

/** Field ids back to the names the rest of the importer speaks. */
export function resolveMapping(
  mapping: Record<string, string>, fields: FieldMeta[],
): { mapping: Record<string, string>; missing: string[] } {
  const byId = new Map(fields.map((f) => [f.internalId, f.name]));
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const [header, fieldId] of Object.entries(mapping)) {
    const name = byId.get(fieldId);
    // A field deleted since the template was saved. Named, not silently
    // dropped: the column it used to fill is about to be ignored.
    if (!name) { missing.push(header); continue; }
    out[header] = name;
  }
  return { mapping: out, missing };
}

export function resolveValues(
  values: Record<string, unknown>, fields: FieldMeta[],
): Record<string, unknown> {
  const byId = new Map(fields.map((f) => [f.internalId, f.name]));
  const out: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(values)) {
    const name = byId.get(fieldId);
    if (name) out[name] = value;
  }
  return out;
}

/** Names to ids, for saving. Anything unknown is left out rather than stored dead. */
export function toFieldIds<T>(
  byName: Record<string, T>, fields: FieldMeta[], keyed: 'value' | 'key',
): Record<string, T> {
  const byName2Id = new Map(fields.map((f) => [f.name, f.internalId]));
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(byName)) {
    if (keyed === 'value') {
      const id = byName2Id.get(String(v));
      if (id) out[k] = id as unknown as T;
    } else {
      const id = byName2Id.get(k);
      if (id) out[id] = v;
    }
  }
  return out;
}

/**
 * Which saved template this file is, if any.
 *
 * Compared on the header row alone, because that is what an exporter keeps
 * stable — the rows below it are different every week. A file matches when
 * nearly all of the template's columns are present: an export that gained a
 * column should still be recognised, one that shares three headers with a
 * thirty-column template should not.
 */
export function detectTemplate(
  headers: string[], templates: ImportTemplate[],
): { template: ImportTemplate; score: number } | null {
  const fold = (h: string): string => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const have = new Set(headers.map(fold));
  let best: { template: ImportTemplate; score: number } | null = null;

  for (const template of templates) {
    if (!template.headers.length) continue;
    const wanted = template.headers.map(fold);
    const found = wanted.filter((h) => have.has(h)).length;
    const score = found / wanted.length;
    if (score >= 0.8 && (!best || score > best.score)) best = { template, score };
  }
  return best;
}

export async function recordUse(id: string, conn: Tx = db): Promise<void> {
  await conn.query(
    `UPDATE ipy_import_template SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1`,
    [id],
  );
}
