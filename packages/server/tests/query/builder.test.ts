/**
 * Unit tests for core/query/builder.ts — the FilterGroup → SQL engine.
 *
 * These exercise the SQL shapes the query builder emits (not a live Postgres):
 * operator coverage, column vs json storage, parameter binding, identifier
 * hardening and order-by fallbacks. Cross-module lookup resolution uses a
 * stubbed metadata registry so no DB is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOrderBy,
  buildSearchClause,
  buildWhere,
  isSystemField,
  quoteIdent,
  resolveFieldPath,
  SqlParams,
  systemFieldExpr,
} from '../../src/core/query/builder.js';
import { ctx, field, module } from '../helpers.js';

const regState = vi.hoisted(() => {
  const mods = new Map<string, Parameters<typeof module>[0] & { fields: ReturnType<typeof field>[] }>();
  return {
    mods,
    registry: {
      requireModule: vi.fn(async (name: string) => {
        const m = mods.get(name);
        if (!m) throw new Error(`no such module ${name}`);
        return m;
      }),
      getModule: vi.fn(async (name: string) => mods.get(name) ?? null),
    },
  };
});

vi.mock('../../src/core/metadata/registry.js', () => ({ registry: regState.registry }));

const leads = () =>
  module({
    name: 'leads',
    fields: [
      field({ name: 'first_name', uitype: 'string' }),
      field({ name: 'status', uitype: 'picklist' }),
      field({ name: 'score', uitype: 'score', storage: 'json' }),
      field({ name: 'is_converted', uitype: 'boolean' }),
      field({ name: 'project_id', uitype: 'reference', config: { referenceModules: ['projects'] } }),
      field({ name: 'tags', uitype: 'tags', storage: 'json' }),
      field({ name: 'scheduled_at', uitype: 'datetime' }),
      field({ name: 'next_followup_at', uitype: 'datetime', storage: 'json' }),
      field({ name: 'price', uitype: 'currency', storage: 'json' }),
    ],
  });

describe('SqlParams', () => {
  it('assigns 1-indexed sequential placeholders', () => {
    const p = new SqlParams();
    expect(p.add('a')).toBe('$1');
    expect(p.add('b')).toBe('$2');
    expect(p.length).toBe(2);
    expect(p.all()).toEqual(['a', 'b']);
  });
});

describe('quoteIdent', () => {
  it('accepts plain identifiers', () => {
    expect(quoteIdent('owner_id')).toBe('"owner_id"');
    expect(quoteIdent('Status')).toBe('"Status"');
  });
  it('rejects anything outside the identifier grammar', () => {
    expect(() => quoteIdent('a; DROP TABLE x')).toThrow();
    expect(() => quoteIdent('1abc')).toThrow();
    expect(() => quoteIdent('a b')).toThrow();
    expect(() => quoteIdent('a"b')).toThrow();
  });
});

describe('system fields', () => {
  it('isSystemField recognises ipy_record columns', () => {
    expect(isSystemField('created_at')).toBe(true);
    expect(isSystemField('owner_id')).toBe(true);
    expect(isSystemField('status')).toBe(false);
  });
  it('systemFieldExpr points at the record alias', () => {
    expect(systemFieldExpr('updated_at')).toBe('r.updated_at');
  });
});

describe('fieldExpr storage resolution', () => {
  it('keeps column-stored fields on the payload table', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'New' }] }, p, ctx());
    expect(sql).toBe('(e."status" = $1)');
  });

  it('routes ipy_record-backed fields through the record alias', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'created_at', operator: 'is_me' }] }, p, ctx());
    // created_at is datetime, not owner, but the point here is the alias choice:
    expect(sql).toContain('r.created_at');
  });

  it('casts json-stored numeric fields from their text representation', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'price', operator: 'greater_than', value: 1000000 }] }, p, ctx());
    expect(sql).toBe('(NULLIF(e.custom_fields->>\'price\',\'\')::numeric > $1::numeric)');
  });
});

describe('buildWhere — operator coverage', () => {
  it('returns empty SQL for an undefined/empty filter', async () => {
    const p = new SqlParams();
    const { sql, joins } = await buildWhere(leads(), undefined, p, ctx());
    expect(sql).toBe('');
    expect(joins).toEqual([]);
    expect(p.length).toBe(0);
  });

  it('equals binds the raw value without casts for text/picklist', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'New' }] }, p, ctx());
    expect(sql).toBe('(e."status" = $1)');
    expect(p.all()).toEqual(['New']);
  });

  it('equals null compiles to IS NULL', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: null }] }, p, ctx());
    expect(sql).toBe('(e."status" IS NULL)');
    expect(p.length).toBe(0);
  });

  it('not_equals uses IS DISTINCT FROM', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'status', operator: 'not_equals', value: 'Lost' }] }, p, ctx());
    expect(sql).toBe('((e."status" IS DISTINCT FROM $1))');
  });

  it('numeric comparisons cast both the column expression and the bound param', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'score', operator: 'greater_or_equal', value: '70' }] }, p, ctx());
    expect(sql).toBe('(NULLIF(e.custom_fields->>\'score\',\'\')::numeric >= $1::numeric)');
    expect(p.all()).toEqual([70]);
  });

  it('integer fields truncate and cast to bigint', async () => {
    const m = module({ name: 'leads', fields: [field({ name: 'score', uitype: 'integer' })] });
    const p = new SqlParams();
    const { sql } = await buildWhere(m, { logic: 'AND', conditions: [{ field: 'score', operator: 'greater_than', value: '7.9' }] }, p, ctx());
    expect(sql).toBe('(e."score" > $1::bigint)');
    expect(p.all()).toEqual([7]);
  });

  it('between binds two params', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'price', operator: 'between', value: 1_000_000, value2: 5_000_000 }] }, p, ctx());
    expect(sql).toBe('(NULLIF(e.custom_fields->>\'price\',\'\')::numeric BETWEEN $1::numeric AND $2::numeric)');
    expect(p.all()).toEqual([1_000_000, 5_000_000]);
  });

  it('in/not_in array params cast per uitype', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'status', operator: 'in', value: 'New,Hot' }] }, p, ctx());
    expect(sql).toBe('(e."status" = ANY($1::text[]))');
    expect(p.all()).toEqual([['New', 'Hot']]);

    const p2 = new SqlParams();
    const { sql: sql2 } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'project_id', operator: 'not_in', value: ['p1', 'p2'] }] }, p2, ctx());
    expect(sql2).toBe('((e."project_id" IS NULL OR NOT (e."project_id" = ANY($1::uuid[]))))');
    expect(p2.all()).toEqual([['p1', 'p2']]);
  });

  it('text matching escapes LIKE wildcards', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'first_name', operator: 'contains', value: '50%_o' }] }, p, ctx());
    expect(sql).toBe('(e."first_name"::text ILIKE $1)');
    expect(p.all()).toEqual(['%50\\%\\_o%']);
  });

  it('is_empty/is_not_empty handle text, json arrays and numbers differently', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'first_name', operator: 'is_empty' }] }, p, ctx());
    expect(sql).toBe('((e."first_name" IS NULL OR e."first_name"::text = \'\'))');

    const p2 = new SqlParams();
    const { sql: sql2 } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'tags', operator: 'is_not_empty' }] }, p2, ctx());
    expect(sql2).toBe('((e.custom_fields->\'tags\' IS NOT NULL AND jsonb_array_length(COALESCE(e.custom_fields->\'tags\',\'[]\'::jsonb)) > 0))');

    const p3 = new SqlParams();
    const { sql: sql3 } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'score', operator: 'is_empty' }] }, p3, ctx());
    expect(sql3).toBe('(NULLIF(e.custom_fields->>\'score\',\'\')::numeric IS NULL)');
  });

  it('boolean operators', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'is_converted', operator: 'is_true' }] }, p, ctx());
    expect(sql).toBe('(e."is_converted" = TRUE)');

    const p2 = new SqlParams();
    const { sql: sql2 } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'is_converted', operator: 'is_false' }] }, p2, ctx());
    expect(sql2).toBe('((e."is_converted" = FALSE OR e."is_converted" IS NULL))');
  });

  it('relative date ranges bind the timezone', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'scheduled_at', operator: 'today' }] }, p, ctx({ timezone: 'Asia/Kolkata' }));
    expect(sql).toContain('date_trunc(\'day\', now() AT TIME ZONE $1)');
    expect(sql).toContain("interval '1 day'");
    expect(p.all()).toEqual(['Asia/Kolkata']);
  });

  it('n-day windows compile to now() offsets', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'next_followup_at', operator: 'older_than_n_days', value: 7 }] }, p, ctx());
    expect(sql).toBe('(NULLIF(e.custom_fields->>\'next_followup_at\',\'\')::timestamptz < now() - $1::interval)');
    expect(p.all()).toEqual(['7 days']);
  });

  it('is_me / is_my_team scope to the record alias with uuid params', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_me' }] }, p, ctx());
    expect(sql).toBe('(r.owner_id = $1::uuid)');
    expect(p.all()).toEqual(['u_1']);

    const p2 = new SqlParams();
    const { sql: sql2 } = await buildWhere(
      leads(),
      { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'is_my_team' }] },
      p2,
      ctx({ subordinateIds: ['u_2'], groupIds: ['g_1'] }),
    );
    expect(sql2).toBe('(r.owner_id = ANY($1::uuid[]))');
    expect(p2.all()).toEqual([['u_1', 'u_2', 'g_1']]);
  });

  it('json array containment operators', async () => {
    const p = new SqlParams();
    const { sql } = await buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'tags', operator: 'has_all', value: ['vip', 'hot'] }] }, p, ctx());
    expect(sql).toBe('(COALESCE(e.custom_fields->\'tags\',\'[]\'::jsonb) ?& $1::text[])');
    expect(p.all()).toEqual([['vip', 'hot']]);
  });

  it('AND/OR and nested groups combine with the right joiners', async () => {
    const p = new SqlParams();
    const filter = {
      logic: 'OR' as const,
      conditions: [
        { logic: 'AND' as const, conditions: [{ field: 'status', operator: 'equals', value: 'New' }, { field: 'is_converted', operator: 'is_false' }] },
        { field: 'status', operator: 'equals', value: 'Hot' },
      ],
    };
    const { sql } = await buildWhere(leads(), filter, p, ctx());
    expect(sql).toBe('((e."status" = $1) AND ((e."is_converted" = FALSE OR e."is_converted" IS NULL))) OR (e."status" = $2)');
    expect(p.all()).toEqual(['New', 'Hot']);
  });

  it('rejects unknown fields, unknown operators and SQL-injection identifiers', async () => {
    const p = new SqlParams();
    await expect(buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'nope', operator: 'equals', value: 'x' }] }, p, ctx())).rejects.toThrow(/Unknown field/);
    await expect(buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'status', operator: 'ilike' as never, value: 'x' }] }, p, ctx())).rejects.toThrow(/Unsupported filter operator/);
    await expect(buildWhere(leads(), { logic: 'AND', conditions: [{ field: 'status"; DROP TABLE x', operator: 'equals', value: 'x' }] }, p, ctx())).rejects.toThrow(/Unknown field/);
  });
});

describe('resolveFieldPath — cross-module references', () => {
  beforeEach(() => {
    regState.mods.clear();
  });

  it('joins the target module table and resolves the target field expression', async () => {
    regState.mods.set('projects', module({ name: 'projects', fields: [field({ name: 'city', uitype: 'picklist' })] }));
    const joins = new Map<string, string>();
    const resolved = await resolveFieldPath(leads(), 'project_id.city', joins);
    expect(resolved.expr).toBe('j_project_id."city"');
    expect(resolved.uitype).toBe('picklist');
    expect(joins.get('j_project_id')).toBe('LEFT JOIN "ipy_e_projects" j_project_id ON j_project_id.record_id = e."project_id"');
    expect(resolved.joins).toEqual([joins.get('j_project_id')]);
  });

  it('rejects non-reference and unknown fields', async () => {
    regState.mods.set('projects', module({ name: 'projects', fields: [field({ name: 'city', uitype: 'picklist' })] }));
    const joins = new Map<string, string>();
    await expect(resolveFieldPath(leads(), 'first_name.city', joins)).rejects.toThrow(/not a lookup field/);
    await expect(resolveFieldPath(leads(), 'status.nope', joins)).rejects.toThrow(/not a lookup field/);
    await expect(resolveFieldPath(leads(), 'project_id.nope', joins)).rejects.toThrow(/Unknown field/);
  });
});

describe('buildSearchClause', () => {
  it('searches label, record_number and tsvector', () => {
    const p = new SqlParams();
    const sql = buildSearchClause('John', p);
    expect(sql).toContain('r.label ILIKE $1');
    expect(sql).toContain('r.record_number ILIKE $1');
    expect(sql).toContain("to_tsquery('simple', $2)");
    expect(p.all()).toEqual(['%John%', 'John:*']);
  });

  it('escapes LIKE wildcards and splits the tsquery terms', () => {
    const p = new SqlParams();
    buildSearchClause('50% block 2', p);
    expect(p.all()[0]).toBe('%50\\% block 2%');
    expect(p.all()[1]).toBe('50%:* & block:* & 2:*');
  });

  it('returns empty for a blank term', () => {
    expect(buildSearchClause('   ', new SqlParams())).toBe('');
  });
});

describe('buildOrderBy', () => {
  it('defaults to record updated_at descending', async () => {
    expect(await buildOrderBy(leads(), null, 'desc', new Map())).toBe('r.updated_at DESC');
  });

  it('resolves system and module fields', async () => {
    expect(await buildOrderBy(leads(), 'created_at', 'asc', new Map())).toBe('r.created_at ASC NULLS LAST');
    expect(await buildOrderBy(leads(), 'status', 'desc', new Map())).toBe('e."status" DESC NULLS LAST');
  });

  it('falls back to the default for an unknown field', async () => {
    expect(await buildOrderBy(leads(), 'not_a_field', 'asc', new Map())).toBe('r.updated_at DESC');
  });
});
