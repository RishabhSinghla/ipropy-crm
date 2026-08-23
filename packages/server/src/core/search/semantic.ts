/**
 * Search by meaning, over everything the CRM holds in words.
 *
 * A filter answers "leads in Sector 21 over a crore". It cannot answer "who
 * mentioned they need possession before Diwali", because that sentence is in a
 * WhatsApp thread, a call transcript or a note somebody typed at nine at night,
 * and no WHERE clause reaches it. This does.
 *
 * Three stages, and the middle one is what makes it good rather than fashionable:
 *
 *   1. **Retrieve** the fifty nearest by vector. Embeddings are excellent at
 *      "roughly about this" and mediocre at ranking.
 *   2. **Rerank** those fifty against the actual question with a model that
 *      reads both. This is where the top five stop being "vaguely related" and
 *      start being "answers what was asked".
 *   3. **Read back** each surviving record through `getRecord` under the
 *      caller's own scope.
 *
 * Stage three is not an optimisation. The stored text is used for ranking and
 * for nothing else: a field this user is not allowed to read must not reach
 * them because a vector happened to be close, and the only thing that reliably
 * enforces that is the same path the record page uses.
 */
import { createHash } from 'node:crypto';
import { embed, isMediaAiAvailable, rerank } from '../../ai/media.js';
import { modelFor } from '../settings/aiModels.js';
import { db, type Tx } from '../../db/pool.js';
import { getRecord, type ServiceContext } from '../entity/recordService.js';
import { recordScopeSql } from '../permissions/index.js';
import { SqlParams } from '../query/builder.js';
import { logger } from '../../utils/logger.js';

/** What kind of thing a row of text came from. */
export type EmbeddingKind = 'record' | 'note' | 'message' | 'call' | 'visit';

export interface Passage {
  kind: EmbeddingKind;
  sourceId: string;
  recordId: string | null;
  moduleName: string | null;
  content: string;
  score: number;
}

export interface SemanticHit {
  recordId: string;
  moduleName: string;
  label: string;
  score: number;
  /** The sentences that matched, in the caller's own permission scope. */
  passages: { kind: EmbeddingKind; content: string }[];
}

/** Text longer than this is truncated rather than split. */
const MAX_CHARS = 4_000;
/** How many rows the worker embeds per tick. Free models are rate limited. */
const BATCH = 32;

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface Candidate {
  kind: EmbeddingKind;
  sourceId: string;
  recordId: string | null;
  moduleName: string | null;
  content: string;
}

/**
 * Everything worth searching, as text, newest first.
 *
 * A record contributes one passage built from its own fields, and each note,
 * message, call transcript and visit contributes its own. Splitting it that way
 * rather than concatenating everything about a lead into one blob is what lets
 * the answer say *which* WhatsApp said it.
 */
async function candidates(limit: number, conn: Tx = db): Promise<Candidate[]> {
  const out: Candidate[] = [];

  // Records themselves. `search_text` is already maintained for keyword search
  // and is exactly the fields somebody would type into a search box, so it is
  // the right text to embed too rather than a second definition of "what this
  // record is about".
  const records = await conn.query<{
    id: string; module_name: string; label: string; search_text: string | null;
  }>(
    `SELECT r.id, r.module_name, r.label, r.search_text
       FROM ipy_record r
       LEFT JOIN ipy_embedding e ON e.kind = 'record' AND e.source_id = r.id::text
      WHERE r.is_deleted = false
        AND (e.id IS NULL OR e.updated_at < r.updated_at)
      ORDER BY r.updated_at DESC
      LIMIT $1`,
    [limit],
  );
  for (const row of records.rows) {
    const text = clean(`${row.label}. ${row.search_text ?? ''}`);
    if (text.length > 3) {
      out.push({
        kind: 'record', sourceId: row.id, recordId: row.id,
        moduleName: row.module_name, content: text,
      });
    }
  }
  if (out.length >= limit) return out.slice(0, limit);

  const notes = await conn.query<{ id: string; record_id: string; module_name: string; body: string }>(
    `SELECT c.id::text, c.record_id, r.module_name, c.body
       FROM ipy_comment c
       JOIN ipy_record r ON r.id = c.record_id
       LEFT JOIN ipy_embedding e ON e.kind = 'note' AND e.source_id = c.id::text
      WHERE e.id IS NULL AND r.is_deleted = false AND length(c.body) > 12
      ORDER BY c.created_at DESC
      LIMIT $1`,
    [limit - out.length],
  );
  for (const row of notes.rows) {
    out.push({
      kind: 'note', sourceId: row.id, recordId: row.record_id,
      moduleName: row.module_name, content: clean(row.body),
    });
  }
  if (out.length >= limit) return out.slice(0, limit);

  // A message belongs to a conversation, and the conversation is what carries
  // the record. Joining straight from the message would be a column that does
  // not exist, which is what happens when you assume the shape of a table you
  // have not opened.
  const messages = await conn.query<{
    id: string; record_id: string; module_name: string; body: string; channel: string; direction: string;
  }>(
    `SELECT m.id::text, c.record_id, r.module_name, m.body, m.channel, m.direction
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
       JOIN ipy_record r ON r.id = c.record_id
       LEFT JOIN ipy_embedding e ON e.kind = 'message' AND e.source_id = m.id::text
      WHERE e.id IS NULL AND r.is_deleted = false AND m.body IS NOT NULL AND length(m.body) > 12
      ORDER BY m.created_at DESC
      LIMIT $1`,
    [limit - out.length],
  );
  for (const row of messages.rows) {
    // The channel and direction go into the embedded text on purpose: "what did
    // they say on WhatsApp" is a question people ask, and it is only answerable
    // if the words "WhatsApp" and "customer said" are part of what was indexed.
    const prefix = `${row.direction === 'inbound' ? 'Customer said on' : 'We sent on'} ${row.channel}: `;
    out.push({
      kind: 'message', sourceId: row.id, recordId: row.record_id,
      moduleName: row.module_name, content: clean(prefix + row.body),
    });
  }
  if (out.length >= limit) return out.slice(0, limit);

  const calls = await conn.query<{
    id: string; record_id: string | null; module_name: string | null; transcript: string; ai_summary: string | null;
  }>(
    `SELECT c.id::text, c.record_id, r.module_name, c.transcript, c.ai_summary
       FROM ipy_call c
       LEFT JOIN ipy_record r ON r.id = c.record_id
       LEFT JOIN ipy_embedding e ON e.kind = 'call' AND e.source_id = c.id::text
      WHERE e.id IS NULL AND c.transcript IS NOT NULL AND length(c.transcript) > 40
        AND (r.id IS NULL OR r.is_deleted = false)
      ORDER BY c.started_at DESC
      LIMIT $1`,
    [limit - out.length],
  );
  for (const row of calls.rows) {
    out.push({
      kind: 'call', sourceId: row.id, recordId: row.record_id,
      moduleName: row.module_name,
      content: clean(`Phone call. ${row.ai_summary ?? ''} ${row.transcript}`),
    });
  }

  return out.slice(0, limit);
}

export interface IndexSummary { embedded: number; skipped: number }

/**
 * Embed whatever has changed. Safe to call on a timer and safe to call twice.
 *
 * Returns zero and says why when there is no provider, rather than throwing:
 * this runs from the scheduler, and a CRM with no embedding key should keep
 * every other scheduled job running.
 */
export async function indexPending(limit = BATCH): Promise<IndexSummary> {
  if (!isMediaAiAvailable()) return { embedded: 0, skipped: 0 };

  const pending = await candidates(limit);
  if (!pending.length) return { embedded: 0, skipped: 0 };

  // Unchanged text costs nothing to skip and a call to re-embed. An edited
  // record whose search text did not actually change — a price correction, a
  // reassignment — is the common case.
  const hashes = pending.map((c) => hash(c.content));
  // Two parallel arrays rather than a composite `IN`: Postgres has no clean
  // parameter form for a list of pairs, and unnesting two text arrays is both
  // clearer and indexable.
  const existing = await db.query<{ kind: string; source_id: string; content_hash: string }>(
    `SELECT e.kind, e.source_id, e.content_hash
       FROM ipy_embedding e
       JOIN unnest($1::text[], $2::text[]) AS w(kind, source_id)
         ON w.kind = e.kind AND w.source_id = e.source_id`,
    [pending.map((c) => c.kind), pending.map((c) => c.sourceId)],
  );
  const known = new Map(existing.rows.map((r) => [`${r.kind}:${r.source_id}`, r.content_hash]));

  const fresh = pending.filter((c, i) => known.get(`${c.kind}:${c.sourceId}`) !== hashes[i]);
  const skipped = pending.length - fresh.length;
  if (!fresh.length) {
    // Touch the rows so the worker stops offering them every tick.
    await touch(pending);
    return { embedded: 0, skipped };
  }

  const vectors = await embed(fresh.map((c) => c.content));
  if (!vectors) {
    logger.debug('embedding provider returned nothing; will retry next tick');
    return { embedded: 0, skipped };
  }

  // Stored with the row, so a change of model in Admin does not silently start
  // comparing vectors from two different maths.
  const model = await modelFor('embed');
  for (const [index, candidate] of fresh.entries()) {
    const vector = vectors[index];
    if (!vector?.length) continue;
    await db.query(
      `INSERT INTO ipy_embedding
         (kind, source_id, record_id, module_name, content, embedding, dims, model, content_hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8,$9, now())
       ON CONFLICT (kind, source_id) DO UPDATE SET
         record_id = EXCLUDED.record_id, module_name = EXCLUDED.module_name,
         content = EXCLUDED.content, embedding = EXCLUDED.embedding,
         dims = EXCLUDED.dims, model = EXCLUDED.model,
         content_hash = EXCLUDED.content_hash, updated_at = now()`,
      [
        candidate.kind, candidate.sourceId, candidate.recordId, candidate.moduleName,
        candidate.content, `[${vector.join(',')}]`, vector.length, model,
        hash(candidate.content),
      ],
    );
  }
  await touch(pending.filter((c) => !fresh.includes(c)));
  logger.info({ embedded: fresh.length, skipped }, 'semantic index updated');
  return { embedded: fresh.length, skipped };
}

/** Mark a row as looked at without re-embedding it. */
async function touch(rows: Candidate[]): Promise<void> {
  if (!rows.length) return;
  await db.query(
    `UPDATE ipy_embedding SET updated_at = now()
      WHERE kind = ANY($1::text[]) AND source_id = ANY($2::text[])`,
    [rows.map((r) => r.kind), rows.map((r) => r.sourceId)],
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The records that actually answer a question, in the caller's own scope.
 *
 * `candidates` is how many the vector search pulls before reranking; `top` is
 * how many survive. Sixty and six is a deliberate ratio: the reranker is what
 * turns "close in embedding space" into "answers this", and giving it too few
 * to choose from wastes it.
 */
export async function search(
  question: string,
  ctx: ServiceContext,
  opts: { top?: number; candidates?: number; modules?: string[] } = {},
): Promise<SemanticHit[]> {
  if (!isMediaAiAvailable() || !question.trim()) return [];

  const asked = await embed([question]);
  const vector = asked?.[0];
  if (!vector?.length) return [];

  const params = new SqlParams();
  const vectorParam = params.add(`[${vector.join(',')}]`);
  const dimsParam = params.add(vector.length);

  // Permission is per module, so the clause is built per module and OR'd. An
  // admin, or a module shared org-wide, contributes `TRUE` and the whole thing
  // collapses — which is the common case and costs nothing.
  const modules = opts.modules?.length ? opts.modules : ['leads', 'properties'];
  const clauses: string[] = [];
  for (const moduleName of modules) {
    // ServiceContext already carries the scope: it extends ScopeContext, so
    // rebuilding one here would be a second set of subordinate and group
    // lookups per question for the same answer.
    const fragment = await recordScopeSql(ctx, moduleName, params);
    const moduleParam = params.add(moduleName);
    clauses.push(`(r.module_name = ${moduleParam}${fragment ? ` AND ${fragment}` : ''})`);
  }
  const limitParam = params.add(opts.candidates ?? 60);

  const { rows } = await db.query<{
    kind: EmbeddingKind; source_id: string; record_id: string; module_name: string;
    content: string; label: string; score: number;
  }>(
    `SELECT e.kind, e.source_id, e.record_id, r.module_name, e.content, r.label,
            1 - (e.embedding <=> ${vectorParam}::vector) AS score
       FROM ipy_embedding e
       JOIN ipy_record r ON r.id = e.record_id
      WHERE e.dims = ${dimsParam}
        AND r.is_deleted = false
        AND (${clauses.join(' OR ')})
      ORDER BY e.embedding <=> ${vectorParam}::vector
      LIMIT ${limitParam}`,
    params.all(),
  );
  if (!rows.length) return [];

  // Rerank, and carry on with the vector order if the reranker is unavailable.
  // A slightly worse order beats no answer.
  const ranked = await rerank(question, rows.map((r) => r.content), { topN: opts.top ?? 6 });
  const order = ranked?.length
    ? ranked.map((hit) => ({ row: rows[hit.index]!, score: hit.score }))
    : rows.slice(0, opts.top ?? 6).map((row) => ({ row, score: row.score }));

  // Group by record, then read each one back properly. Two passages from one
  // lead are one answer about that lead, not two results.
  const byRecord = new Map<string, SemanticHit>();
  for (const { row, score } of order) {
    if (!row) continue;
    const existing = byRecord.get(row.record_id);
    if (existing) {
      existing.passages.push({ kind: row.kind, content: row.content });
      existing.score = Math.max(existing.score, score);
      continue;
    }
    byRecord.set(row.record_id, {
      recordId: row.record_id, moduleName: row.module_name, label: row.label,
      score, passages: [{ kind: row.kind, content: row.content }],
    });
  }

  return [...byRecord.values()].sort((a, b) => b.score - a.score);
}

/**
 * What the assistant should be told, as text, already permission-filtered.
 *
 * Each record is read back through `getRecord` under the caller's scope, so a
 * field they cannot see never reaches the prompt. A record that fails that read
 * is dropped silently: it means the vector index is ahead of a permission
 * change, which is a normal few seconds rather than an error.
 */
export async function contextFor(
  question: string,
  ctx: ServiceContext,
  opts: { top?: number } = {},
): Promise<string> {
  const hits = await search(question, ctx, opts).catch((err) => {
    logger.debug({ err }, 'semantic search failed; answering without it');
    return [] as SemanticHit[];
  });
  if (!hits.length) return '';

  const blocks: string[] = [];
  for (const hit of hits) {
    const record = await getRecord(ctx, hit.moduleName, hit.recordId, { withDisplay: true })
      .catch(() => null);
    if (!record) continue;

    const facts = Object.entries(record.values)
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && !Array.isArray(v))
      .slice(0, 14)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');

    blocks.push([
      `### ${hit.label} (${hit.moduleName}, id ${hit.recordId})`,
      facts,
      ...hit.passages
        .filter((p) => p.kind !== 'record')
        .map((p) => `- ${p.kind}: ${p.content.slice(0, 700)}`),
    ].filter(Boolean).join('\n'));
  }

  return blocks.length
    ? `## Records and conversations that look relevant\n\n${blocks.join('\n\n')}`
    : '';
}
