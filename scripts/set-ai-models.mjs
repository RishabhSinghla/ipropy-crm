#!/usr/bin/env node
/**
 * Point each AI job at a better model — after checking the id really exists.
 *
 * Four wrong model ids have shipped in this project by somebody typing what
 * looked right, so nothing here is written on a guess. Every id is checked
 * against OpenRouter's live catalogue first, and one it cannot find stops the
 * run rather than being saved.
 *
 * **Asked per modality, not against the plain list.** `/models` on its own is
 * chat only; an embedding or rerank id checked against it finds nothing and
 * reads as "this model does not exist" — which is precisely how four working
 * ids got written off once already. `ai/modelCatalogue.ts` learned that the
 * hard way and this follows it: `?output_modalities=embeddings`, `=rerank`,
 * `=text`.
 *
 * No key is needed. OpenRouter publishes the catalogue unauthenticated, which
 * matters here because production generates its own JWT_SECRET, so a build
 * runner cannot decrypt the stored key even though the row is right there.
 *
 *   APPLY=apply node scripts/set-ai-models.mjs     # save
 *   node scripts/set-ai-models.mjs                 # check only
 *
 * PROD_DATABASE_URL or DATABASE_URL picks the database.
 */
import pg from 'pg';

const apply = process.env.APPLY === 'apply';
const url = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('No database URL. Refusing to guess which database to write to.');
  process.exit(1);
}

/**
 * What each job should ask for, and why — so whoever reads this next can judge
 * whether the reason still holds, rather than just seeing a slug.
 */
const WANTED = [
  {
    key: 'ai_models.embed',
    job: 'Search',
    modality: 'embeddings',
    ids: ['baai/bge-m3', 'qwen/qwen3-embedding-8b', 'qwen/qwen3-embedding-4b'],
    why: '8B and multilingual at $0.01/M. The notes here are Hinglish — "Ye 3.30 pm tak aayega" — '
      + 'and the old 1B free model was rationed to fifty calls a day, which is why the index stalled.',
  },
  {
    key: 'ai_models.rerank',
    job: 'Reorder results',
    modality: 'rerank',
    ids: ['voyageai/rerank-2.5-lite', 'voyageai/rerank-2.5', 'qwen/qwen3-reranker-8b'],
    why: '32K context against the free one\'s 10K, so a long property description is ranked whole '
      + 'rather than cut off. Priced at $0.02/M — not free, whatever the pricing block says — but it '
      + 'sees about thirty results per search, so the spend stays small.',
  },
  {
    key: 'ai_models.copy',
    job: 'Write listing copy',
    modality: 'text',
    ids: ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3', 'deepseek/deepseek-v4-flash'],
    why: 'This box was empty, so listing copy fell back to the photo-reading model. '
      + 'These are the words a customer actually reads.',
  },
];

/**
 * The chat model on the OpenRouter card.
 *
 * A router rather than a fixed id, because today's whole incident was retired
 * model names: `openrouter/auto` picks per request from what the market is
 * actually using. `openrouter/free` is the fallback and is not a guess — this
 * CRM's own log has it at 124 calls and 124 successes.
 */
const CHAT_MODELS = ['openrouter/auto', 'openrouter/free'];

/** One modality's catalogue, or null when OpenRouter cannot be reached. */
async function catalogue(modality) {
  try {
    const response = await fetch(
      `https://openrouter.ai/api/v1/models?output_modalities=${encodeURIComponent(modality)}`,
      { signal: AbortSignal.timeout(15_000), headers: { 'X-Title': 'iPropy CRM' } },
    );
    if (!response.ok) {
      console.error(`  OpenRouter answered ${response.status} for ${modality}`);
      return null;
    }
    const body = await response.json();
    return new Map((body.data ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => [m.id, m]));
  } catch (err) {
    console.error(`  could not reach OpenRouter for ${modality}: ${err.message}`);
    return null;
  }
}

/**
 * A zero in the pricing block is not the same as free.
 *
 * Only a `:free` id is actually free. An empty or zero pricing block means
 * *billed elsewhere* — every rerank and video model has one — and reading it as
 * free is a mistake this project has already made once and made again on
 * 16 September, when this script reported `voyageai/rerank-2.5-lite` as free
 * and OpenRouter's own catalogue page prices it at $0.02 per million.
 */
const perMillion = (model, id) => {
  const prompt = Number(model?.pricing?.prompt ?? NaN);
  if (id.endsWith(':free')) return 'free';
  if (!Number.isFinite(prompt) || prompt === 0) return 'priced, but not in the pricing block — check the model page';
  return `$${(prompt * 1_000_000).toFixed(3)} per million in`;
};

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows: [{ db }] } = await client.query('SELECT current_database() AS db');
  console.log(`database: ${db}`);
  console.log(apply ? 'mode    : saving\n' : 'mode    : checking only, nothing will be written\n');

  const plan = [];
  let unavailable = 0;

  for (const want of WANTED) {
    const served = await catalogue(want.modality);
    const current = await client.query(
      `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = $1`, [want.key],
    ).then((r) => r.rows[0]?.value || '(not set)');

    if (!served) {
      unavailable += 1;
      console.log(`  ? ${want.job}: cannot check right now, so staying on ${current}`);
      continue;
    }

    const chosen = want.ids.find((id) => served.has(id));
    if (!chosen) {
      unavailable += 1;
      console.log(`  x ${want.job}: OpenRouter serves none of ${want.ids.join(', ')} for ${want.modality}`);
      console.log(`     staying on ${current}`);
      continue;
    }

    console.log(`  ok ${want.job}: ${current}  ->  ${chosen}  (${perMillion(served.get(chosen), chosen)})`);
    console.log(`     ${want.why}`);
    if (chosen !== current) plan.push({ key: want.key, id: chosen });
  }

  const chatServed = await catalogue('text');
  const chatModel = chatServed ? CHAT_MODELS.find((id) => chatServed.has(id)) : null;
  console.log(chatModel
    ? `\n  ok Chat model on the OpenRouter card -> ${chatModel}`
    : '\n  x Chat model: neither router is listed, leaving the card alone');
  if (!chatModel) unavailable += 1;

  if (!apply) {
    console.log(`\nChecked only. ${plan.length} would change, ${unavailable} could not be confirmed.`);
    console.log('Re-run with APPLY=apply to save.');
    process.exit(0);
  }

  for (const { key, id } of plan) {
    await client.query(
      `INSERT INTO ipy_setting (key, value, category, label)
       VALUES ($1, to_jsonb($2::text), 'ai', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, id],
    );
    console.log(`saved ${key} = ${id}`);
  }

  if (chatModel) {
    // A model id is not a secret, so it lives in config rather than credentials.
    await client.query(
      `UPDATE ipy_integration
          SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{model}', to_jsonb($1::text), true)
        WHERE provider = 'ai_openrouter'`,
      [chatModel],
    );
    console.log(`saved the OpenRouter card's model = ${chatModel}`);
  }

  if (!plan.length && !chatModel) {
    console.log('Nothing changed.');
  } else {
    console.log('\nDone. Changing the search model re-indexes over the following hour, so results');
    console.log('will be thin until that finishes and better afterwards.');
  }
} finally {
  await client.end();
}
