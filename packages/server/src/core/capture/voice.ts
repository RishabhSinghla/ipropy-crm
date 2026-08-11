/**
 * The twenty seconds somebody speaks at the gate, turned into fields.
 *
 *   "B-110 Greenfield, second floor, four BHK, 325 gaj, asking three point two
 *    five crore, two parking, lift, ready to move, park facing"
 *
 * Everything in that sentence is already a field on the property record. Typing
 * it is nine dropdowns and four number pads standing in the sun; saying it is
 * one breath. For a team who are quick on a phone call and slow on a phone
 * keyboard, that difference is whether the CRM gets used at all.
 *
 * Two rules this is built on:
 *
 * Nothing is written to the record. Parsed values land on the session for
 * somebody to confirm that evening. A misheard price is materially worse than
 * an empty one — "three point two five" and "three twenty five" are one bad
 * decode apart, and a property listed at the wrong crore figure is a real
 * problem with a real customer.
 *
 * The model does language; we do types. It is asked for values in the form the
 * speaker used ("3.25 cr", "4 BHK"), and the conversion to 32500000 is done
 * here by `parseIndianPrice` — deterministic, testable, and not something to
 * hand to a language model when it is the number that matters most.
 *
 * Degrades all the way down, like every other AI feature here: no STT key means
 * the audio is still stored and playable; no AI provider means the transcript
 * is still saved and readable. Neither throws.
 */
import type { FieldMeta } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registry } from '../metadata/registry.js';
import { getSettings } from '../settings/integrations.js';
import { getDriver } from '../storage/index.js';
import { isSttConfigured, transcribeAudio } from '../stt/index.js';
import { coerceSpokenValue } from './spoken.js';
import { completeJson, isAiAvailable } from '../../ai/client.js';

/** Give up after this many failed transcriptions of the same clip. */
const MAX_ATTEMPTS = 3;

/**
 * Spelling hints for the decoder.
 *
 * Whisper takes a prompt as a style/vocabulary sample, and site notes are full
 * of terms it otherwise mangles — "BHK" becomes "B-H-K", "gaj" becomes "gauge",
 * "crore" becomes "crow". Seeding it with the vocabulary is the cheapest
 * accuracy win available.
 */
const STT_PROMPT = 'Indian real estate site notes. Vocabulary: BHK, crore, lakh, '
  + 'sq ft, sq yd, gaj, builder floor, kothi, plot, carpet area, super area, '
  + 'east facing, park facing, corner, ready to move, under construction, '
  + 'RERA, khasra, freehold, semi-furnished, modular kitchen, stilt parking.';

export interface ParsedTranscript {
  /** Field name → coerced value, only where the value survived type coercion. */
  values: Record<string, unknown>;
  /** What the speaker actually said for each field, kept for the review screen. */
  heard: Record<string, string>;
  /** Things said that did not map to any field — surfaced rather than dropped. */
  unmatched: string[];
}

interface ModelOutput {
  fields?: Record<string, string>;
  unmatched?: string[];
}

/** Fields worth offering the model — writable, visible, and not machine-owned. */
async function catalogue(moduleName: string): Promise<{ field: FieldMeta; options: string[] }[]> {
  const module = await registry.requireModule(moduleName);
  const out: { field: FieldMeta; options: string[] }[] = [];

  for (const field of module.fields) {
    if (field.isReadonly || field.displayType === 'hidden') continue;
    if (['autonumber', 'rollup', 'owner', 'user', 'reference', 'multireference', 'image', 'json'].includes(field.uitype)) continue;

    let options: string[] = [];
    const picklist = (field.config as { picklist?: string } | undefined)?.picklist;
    if (picklist) {
      options = (await registry.getPicklist(picklist) ?? [])
        .filter((o) => o.isActive !== false)
        .map((o) => o.label || o.value);
    }
    out.push({ field, options });
  }
  return out;
}

/**
 * Ask the model to map a spoken note onto the module's fields.
 *
 * Returns null when no AI provider is configured — the transcript is still
 * saved and perfectly readable, which is most of the value on its own.
 */
export async function parseTranscript(transcript: string, moduleName: string): Promise<ParsedTranscript | null> {
  if (!transcript.trim() || !isAiAvailable()) return null;

  const entries = await catalogue(moduleName);
  const described = entries.map(({ field, options }) => {
    const type = options.length ? `one of: ${options.join(' | ')}` : field.uitype;
    return `- ${field.name} (${field.label}): ${type}`;
  }).join('\n');

  const result = await completeJson<ModelOutput>({
    feature: 'capture_voice_parse',
    fast: true,
    temperature: 0,
    system: 'You extract structured property details from a spoken site-visit note taken by an '
      + 'Indian real-estate agent. The speech is often Hindi-English code-mixed.\n\n'
      + 'Rules:\n'
      + '- Only output a field if the speaker actually said it. Never infer, never guess, never fill a default.\n'
      + '- Write values the way the speaker said them: "3.25 cr", "325 gaj", "4 BHK", "2nd". '
      + 'Do NOT convert to digits or expand units — that is handled downstream.\n'
      + '- For a field listed with allowed options, output exactly one of those options, copied verbatim.\n'
      + '- Anything said that fits no field goes in "unmatched", in the speaker\'s words.\n'
      + '- "gaj" means square yards. A lakh is 100000 and a crore is 10000000, but do not do the arithmetic.',
    prompt: `Fields available:\n${described}\n\nSpoken note:\n"""${transcript.slice(0, 4000)}"""\n\n`
      + 'Respond as {"fields": {"field_name": "value as spoken"}, "unmatched": ["..."]}',
    maxTokens: 800,
  });

  if (!result) return null;

  const byName = new Map(entries.map((e) => [e.field.name, e]));
  const values: Record<string, unknown> = {};
  const heard: Record<string, string> = {};

  for (const [name, spoken] of Object.entries(result.fields ?? {})) {
    const entry = byName.get(name);
    // A hallucinated field name is dropped rather than stored — it would only
    // reappear as a phantom row on the review screen.
    if (!entry || typeof spoken !== 'string') continue;
    const value = coerceSpokenValue(entry.field, spoken, entry.options);
    if (value === undefined) continue;
    values[name] = value;
    heard[name] = spoken.trim();
  }

  return {
    values,
    heard,
    unmatched: (result.unmatched ?? []).filter((u) => typeof u === 'string').slice(0, 20),
  };
}

interface PendingRow {
  id: string;
  record_id: string | null;
  voice_note_id: string;
  voice_attempts: number;
  storage_key: string;
  file_name: string;
  module_name: string | null;
}

/**
 * Transcribe and parse the voice notes waiting on it.
 *
 * Polled from the scheduler. Small batches because each one is a network call
 * to a transcription provider on a free tier, and there are only ever a handful
 * a day — throughput is not the constraint, not falling over is.
 */
export async function processPendingVoiceNotes(limit = 5): Promise<{ done: number; failed: number }> {
  const stt = getSettings().stt;
  // Not an error, and not worth logging every minute: an install with no STT
  // key simply keeps the audio.
  if (!isSttConfigured(stt)) return { done: 0, failed: 0 };

  const { rows } = await db.query<PendingRow>(
    `SELECT s.id, s.record_id, s.voice_note_id, s.voice_attempts,
            a.storage_key, a.file_name, r.module_name
       FROM ipy_shoot_session s
       JOIN ipy_attachment a ON a.id = s.voice_note_id
       LEFT JOIN ipy_record r ON r.id = s.record_id
      WHERE s.voice_status = 'pending' AND s.voice_attempts < $1
      ORDER BY s.created_at
      LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
  if (!rows.length) return { done: 0, failed: 0 };

  const driver = await getDriver();
  let done = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const audio = await driver.read(row.storage_key);
      if (!audio) throw new Error('voice note missing from storage');

      const transcript = await transcribeAudio(audio, row.file_name, stt, {
        language: 'en',
        prompt: STT_PROMPT,
      });

      // Parsing is best-effort on purpose: a transcript with no parsed fields is
      // still a useful thing to read, so a parse failure must not fail the job
      // and lose the transcription that was already paid for.
      let parsed: ParsedTranscript | null = null;
      try {
        parsed = await parseTranscript(transcript, row.module_name ?? 'properties');
      } catch (err) {
        logger.warn({ err, sessionId: row.id }, 'capture: voice parse failed, keeping transcript');
      }

      await db.query(
        `UPDATE ipy_shoot_session
            SET transcript = $2, parsed = $3::jsonb, voice_status = 'done',
                voice_error = NULL, voice_attempts = voice_attempts + 1, updated_at = now()
          WHERE id = $1`,
        [row.id, transcript, JSON.stringify(parsed ?? {})],
      );
      done += 1;
    } catch (err) {
      const attempts = row.voice_attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      await db.query(
        `UPDATE ipy_shoot_session
            SET voice_attempts = $2,
                voice_status = CASE WHEN $2 >= $3 THEN 'failed' ELSE 'pending' END,
                voice_error = $4, updated_at = now()
          WHERE id = $1`,
        [row.id, attempts, MAX_ATTEMPTS, message.slice(0, 500)],
      );
      failed += 1;
      logger.warn({ err, sessionId: row.id, attempts }, 'capture: voice transcription failed');
    }
  }

  if (done || failed) logger.info({ done, failed }, 'capture: voice notes processed');
  return { done, failed };
}
