/**
 * Resolve browser-facing attachment URLs into private storage keys.
 *
 * Render requests never fetch arbitrary URLs. Apart from being an SSRF risk,
 * the CRM's own `/api/files/:id` endpoint requires a session the background
 * worker does not have. The request boundary verifies the owning record, then
 * freezes only the corresponding storage keys into the job specification.
 */
import { db } from '../../db/pool.js';
import { BadRequestError } from '../../utils/errors.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const FILE_PATH = new RegExp(`(?:^|/)api/files/(${UUID})(?:[/?#]|$)`, 'i');

export interface BrowserImageSource {
  url: string;
  caption?: string;
}
export function attachmentIdFromUrl(value: string): string | null {
  return FILE_PATH.exec(value)?.[1] ?? null;
}

export async function resolveImageSources(
  sources: BrowserImageSource[],
  recordId: string,
): Promise<{ key: string; caption?: string }[]> {
  const requested = sources.map((source) => ({ ...source, id: attachmentIdFromUrl(source.url) }));
  if (requested.some((source) => !source.id)) {
    throw new BadRequestError('Render photos must come from the selected CRM record');
  }

  const ids = [...new Set(requested.map((source) => source.id!))];
  const rows = await db.query<{ id: string; storage_key: string; mime_type: string; record_id: string | null }>(
    `SELECT id, storage_key, mime_type, record_id
     FROM ipy_attachment
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));

  return requested.map((source) => {
    const row = byId.get(source.id!);
    if (!row || row.record_id !== recordId || !row.mime_type.startsWith('image/')) {
      throw new BadRequestError('One or more render photos do not belong to the selected record');
    }
    return { key: row.storage_key, ...(source.caption ? { caption: source.caption } : {}) };
  });
}
