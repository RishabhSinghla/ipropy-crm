/**
 * The property's details, written into its own folder as a plain text file.
 *
 * Whoever is uploading photos is standing in OneDrive, not in the CRM. Without
 * this they have a folder named after a slug and no way to be sure it is the
 * right one — and "which of these two Tower B folders is the 4 BHK" is exactly
 * the mistake that puts a floor's photos on the wrong record.
 *
 * Plain text, not JSON. A person opens this on a phone in a lift; JSON is for
 * n8n, which is reading the CRM's API anyway.
 *
 * Rewritten whenever the folder pass runs, so editing the property updates the
 * file. The file is never read back by the CRM — it exists for the human and
 * is safe to overwrite.
 */
import { db } from '../../db/pool.js';
import { formatIndianPrice } from '@ipropy/shared';
import type { StorageDriver } from './index.js';

export const DETAILS_FILE = 'PROPERTY DETAILS.txt';

interface Row {
  label: string | null;
  [key: string]: unknown;
}

/** Only fields worth reading in a lift. Blank ones are left out entirely. */
const FIELDS: { key: string; label: string; money?: boolean }[] = [
  { key: 'name', label: 'Unit' },
  { key: 'project_name', label: 'Project' },
  { key: 'property_type', label: 'Type' },
  { key: 'configuration', label: 'Configuration' },
  { key: 'status', label: 'Status' },
  { key: 'tower_block', label: 'Tower / Block' },
  { key: 'floor', label: 'Floor' },
  { key: 'facing', label: 'Facing' },
  { key: 'carpet_area', label: 'Carpet area' },
  { key: 'super_built_up_area', label: 'Super built-up area' },
  { key: 'total_price', label: 'Price', money: true },
  { key: 'locality', label: 'Locality' },
  { key: 'city', label: 'City' },
];

function line(label: string, value: string): string {
  return `${label.padEnd(22)}${value}`;
}

export async function writePropertyDetails(
  driver: StorageDriver,
  recordId: string,
  folder: string,
): Promise<void> {
  const row = await db.queryOne<Row>(
    `SELECT r.label, p.* FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
      WHERE p.record_id = $1`,
    [recordId],
  );
  if (!row) return;

  const lines: string[] = [
    String(row.label ?? 'Property'),
    '='.repeat(Math.max(12, String(row.label ?? 'Property').length)),
    '',
  ];

  for (const f of FIELDS) {
    const raw = row[f.key];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = f.money && typeof raw === 'number'
      ? formatIndianPrice(raw)
      : Array.isArray(raw) ? raw.join(', ') : String(raw);
    if (!value.trim()) continue;
    lines.push(line(f.label, value));
  }

  lines.push(
    '',
    '-'.repeat(60),
    'Put the original photos and videos straight into this folder.',
    'Then go back to the CRM, open this property and press Finish.',
    'Everything else — renaming, compressing, watermarks, the social and',
    'website folders — is done for you after that.',
    '',
    'Do not rename or move anything by hand; the processing reads this folder.',
    '',
    // Not a timestamp of "now" on purpose: this file is rewritten on every
    // folder pass, and a changing line would show as a modification in
    // OneDrive every few minutes and train people to ignore the file.
    `Property ID: ${recordId}`,
  );

  await driver.save(`${folder}/${DETAILS_FILE}`, Buffer.from(`${lines.join('\n')}\n`, 'utf8'), 'text/plain');
}
