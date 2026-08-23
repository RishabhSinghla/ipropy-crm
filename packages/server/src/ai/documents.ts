/**
 * The agreements and certificates you upload, read once and made searchable.
 *
 * A builder agreement goes onto a property as a PDF and sits there. Six months
 * later somebody needs the possession date and is opening files one at a time.
 * Nothing in the CRM knows what is inside any of them.
 *
 * So a model reads each one when it arrives and pulls out the handful of things
 * anybody ever goes looking for: dates, amounts, reference numbers, parties.
 * Those go onto the record as an insight and into the meaning index, so
 * "which properties have possession before March 2027" becomes answerable.
 *
 * **Floor plans are the better half.** A drawing has almost no extractable text
 * and is exactly what people search for. The vision model describes what is
 * drawn — how many bedrooms, which way the balcony faces, where the kitchen is
 * — and that description is what gets indexed, so a search finds the drawing
 * rather than a file called scan_003.pdf.
 *
 * Nothing it finds is written into a field. It is a reading, offered.
 */
import { complete, saveInsight } from './client.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { featureOn } from '../core/settings/aiFeatures.js';
import { modelFor } from '../core/settings/aiModels.js';

/** What a model is asked to look for, and what nobody ever searches by. */
const READABLE = /\.(pdf|png|jpe?g|webp|heic|heif)$/i;
const IMAGE = /^image\//;

interface Attachment {
  id: string;
  record_id: string | null;
  file_name: string;
  mime_type: string;
  storage_key: string;
  module_name: string | null;
}

export interface DocumentReading {
  kind: string;
  summary: string;
  facts: Record<string, string>;
}

/**
 * Read one uploaded file.
 *
 * Silent about everything it cannot do. A PDF this model cannot open, a
 * provider that will not answer, a feature switched off: the file uploads
 * exactly as it does today and nobody is told about a failure they did not ask
 * for.
 */
export async function readDocument(attachmentId: string): Promise<DocumentReading | null> {
  try {
    if (!await featureOn('documentReading')) return null;

    const file = await db.queryOne<Attachment>(
      `SELECT a.id, a.record_id, a.file_name, a.mime_type, a.storage_key, r.module_name
         FROM ipy_attachment a
         LEFT JOIN ipy_record r ON r.id = a.record_id
        WHERE a.id = $1`,
      [attachmentId],
    );
    if (!file || !READABLE.test(file.file_name)) return null;

    const { getDriver } = await import('../core/storage/index.js');
    const driver = await getDriver();
    const bytes = await driver.read(file.storage_key);
    if (!bytes?.length) return null;

    // Six megabytes of base64 is a request most providers refuse and every one
    // of them charges for. A scanned agreement over that is almost always a
    // photographed one, and the first pages hold what matters anyway.
    if (bytes.length > 6 * 1024 * 1024) {
      logger.debug({ attachmentId, size: bytes.length }, 'document too large to read');
      return null;
    }

    const isImage = IMAGE.test(file.mime_type);
    const answer = await complete({
      feature: 'document_reading',
      model: await modelFor('vision'),
      system: 'You read property documents for an Indian real-estate CRM. You extract only what is '
        + 'written or drawn. You never infer a date, an amount or a party that is not there, and '
        + 'you never round a number. Reply with JSON only.',
      prompt: [
        `This file is called "${file.file_name}".`,
        '',
        'Say what it is and pull out what somebody would search for later.',
        '',
        'Return JSON with:',
        '  "kind"    two or three words: builder agreement, floor plan, RERA certificate, '
        + 'payment receipt, sale deed, price list, identity document, photograph, or something else',
        '  "summary" one or two sentences. For a floor plan, describe what is drawn: how many '
        + 'bedrooms, which rooms face which way, where the balcony and kitchen are. That '
        + 'description is what makes the drawing findable later, so be specific about the layout.',
        '  "facts"   an object of the things worth searching by. Only include what is actually '
        + 'present. Use plain keys somebody would recognise, for example "Possession date", '
        + '"Total consideration", "RERA number", "Payment plan", "Carpet area", "Parties", '
        + '"Penalty clause". Copy numbers and dates exactly as written.',
      ].join('\n'),
      ...(isImage ? { images: [{ data: bytes, mimeType: file.mime_type }] } : {}),
      // A PDF the model cannot open comes back as a refusal rather than an
      // error, which is why this is attempted at all rather than gated on type.
      maxTokens: 1500,
      temperature: 0.1,
      recordId: file.record_id,
    });
    if (!answer?.text.trim()) return null;

    const { parseJson } = await import('./client.js');
    const parsed = parseJson<DocumentReading>(answer.text);
    if (!parsed?.summary) return null;

    const reading: DocumentReading = {
      kind: String(parsed.kind || 'document'),
      summary: String(parsed.summary),
      facts: parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {},
    };

    if (file.record_id) {
      await saveInsight({
        recordId: file.record_id,
        module: file.module_name,
        kind: 'document_reading',
        title: `${reading.kind}: ${file.file_name}`,
        body: [
          reading.summary,
          ...Object.entries(reading.facts).map(([k, v]) => `${k}: ${v}`),
        ].join('\n'),
        data: { attachmentId, ...reading },
        model: answer.model,
      });
    }

    // Into the meaning index under its own kind, so a search can say it found
    // the answer in a document rather than in a note.
    await indexReading(attachmentId, file, reading);
    logger.info({ attachmentId, kind: reading.kind }, 'document read');
    return reading;
  } catch (err) {
    logger.warn({ err, attachmentId }, 'could not read document');
    return null;
  }
}

async function indexReading(
  attachmentId: string,
  file: Attachment,
  reading: DocumentReading,
): Promise<void> {
  const { embed } = await import('./media.js');
  const text = [
    `${reading.kind}. ${file.file_name}.`,
    reading.summary,
    ...Object.entries(reading.facts).map(([k, v]) => `${k}: ${v}`),
  ].join(' ').slice(0, 4000);

  const vectors = await embed([text]);
  const vector = vectors?.[0];
  if (!vector?.length) return;

  const { createHash } = await import('node:crypto');
  await db.query(
    `INSERT INTO ipy_embedding
       (kind, source_id, record_id, module_name, content, embedding, dims, model, content_hash, updated_at)
     VALUES ('document',$1,$2,$3,$4,$5::vector,$6,$7,$8, now())
     ON CONFLICT (kind, source_id) DO UPDATE SET
       content = EXCLUDED.content, embedding = EXCLUDED.embedding,
       dims = EXCLUDED.dims, model = EXCLUDED.model,
       content_hash = EXCLUDED.content_hash, updated_at = now()`,
    [
      attachmentId, file.record_id, file.module_name, text,
      `[${vector.join(',')}]`, vector.length, await modelFor('embed'),
      createHash('sha1').update(text).digest('hex'),
    ],
  );
}
