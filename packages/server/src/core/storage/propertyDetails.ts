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

import { PROPERTY_MEDIA_FOLDERS } from './keys.js';

export const DETAILS_FILE = 'PROPERTY DETAILS.txt';
export const WHERE_TO_POST_FILE = 'WHERE TO POST.txt';

/**
 * The map from a shape to every place that shape belongs.
 *
 * Folders are named after the shape because five platforms wanting 4:5 should
 * not mean five copies of the same photo. The cost of that is somebody has to
 * know Instagram wants 4:5, and this file is where they find out. It names the
 * exact post type, not just the app: "Instagram" is useless when Instagram has
 * a feed, a reel, a story and a broadcast channel that do not all want the same
 * thing.
 *
 * Written into every property folder, so the answer is next to the files rather
 * than in somebody's head.
 */
const WHERE_TO_POST: { folder: string; size: string; uses: string[] }[] = [
  {
    folder: '02_SHAPES/4x5',
    size: '1080 x 1350 — tall, the one you will use most',
    uses: [
      'Instagram  ->  feed photo, feed carousel, feed video cover',
      'Facebook   ->  page post, profile post, group post, photo album',
      'LinkedIn   ->  photo post, multiple photo post',
      'Threads    ->  photo post, carousel',
      'WhatsApp   ->  sending in a chat or a group',
      'Pinterest  ->  carousel pin',
    ],
  },
  {
    folder: '02_SHAPES/9x16',
    size: '1080 x 1920 — full phone screen, top to bottom',
    uses: [
      'Instagram  ->  reel cover, story, story with a link, highlight',
      'Facebook   ->  reel, page reel, story, page story',
      'YouTube    ->  short',
      'TikTok     ->  video post, photo mode, story',
      'WhatsApp   ->  status photo, status video',
      'Telegram   ->  story',
      'Snapchat   ->  story, spotlight',
      'Pinterest  ->  video pin, idea pin',
    ],
  },
  {
    folder: '02_SHAPES/4x3',
    size: '1600 x 1200 — wide, shows the whole room. This is the property one',
    uses: [
      '99acres      ->  sale listing, rent listing, project listing',
      'Housing.com  ->  sale listing, rent listing',
      'Magicbricks  ->  sale listing, rent listing',
      'NoBroker     ->  sale listing, rent listing',
      'OLX          ->  property ad',
      'Facebook     ->  marketplace listing, photo album',
      'Google       ->  business photos, maps photo',
      'Your website ->  property gallery  (the CRM takes these automatically)',
    ],
  },
  {
    folder: '02_SHAPES/1x1',
    size: '1080 x 1080 — square',
    uses: [
      'Google Business  ->  business update, offer post, event post, product',
      'X (Twitter)      ->  post, multiple image post',
      'Instagram        ->  feed, when you want square instead of tall',
      'YouTube          ->  community post',
    ],
  },
  {
    folder: '02_SHAPES/16x9',
    size: '1920 x 1080 — widescreen, like a television',
    uses: [
      'YouTube      ->  video thumbnail, playlist cover, channel trailer',
      'Your website ->  page hero image, blog article, locality guide',
      'LinkedIn     ->  article image, newsletter image',
      'Facebook     ->  link preview image',
    ],
  },
  {
    folder: '02_SHAPES/2x3',
    size: '1000 x 1500 — very tall. Pinterest only',
    uses: ['Pinterest  ->  image pin'],
  },
  {
    folder: '02_SHAPES/1.91x1',
    size: '1200 x 627 — wide and short. Link previews',
    uses: [
      'Email     ->  property email, newsletter header',
      'LinkedIn  ->  the picture that shows when you share a link',
      'Facebook  ->  the picture that shows when you share a link',
    ],
  },
  {
    folder: '03_EDITED_MEDIA/WATERMARKED',
    size: 'full size, with the iPropy logo on it',
    uses: [
      'Anywhere you are worried about the photo being taken and reused.',
      'Portals and marketplace listings are the usual reason.',
    ],
  },
  {
    folder: '06_VIDEO',
    size: 'the walkthrough, in both shapes, plus a cover picture',
    uses: [
      '<name>-9x16.mp4   ->  reels, shorts, tiktok, whatsapp status, stories',
      '<name>-16x9.mp4   ->  youtube, your website, facebook video post',
      '<name>-cover.jpg  ->  the thumbnail, wherever one is asked for',
    ],
  },
];

/** The whole guide, as plain text, for the property root. */
export function whereToPostText(): string {
  const lines: string[] = [
    'WHERE TO POST WHAT',
    '='.repeat(60),
    '',
    'Every photo you uploaded has been made in several shapes. The folders are',
    'named after the shape rather than the app, because the same shape is used',
    'in a lot of places and one copy is easier to keep straight than six.',
    '',
    'Find the place you are posting to below, and open the folder next to it.',
    '',
  ];

  for (const entry of WHERE_TO_POST) {
    lines.push('-'.repeat(60), entry.folder, `  ${entry.size}`, '');
    for (const use of entry.uses) lines.push(`  ${use}`);
    lines.push('');
  }

  lines.push(
    '-'.repeat(60),
    'A few things worth knowing',
    '',
    '  The originals you uploaded are never touched. They stay exactly as they',
    '  came off the camera in 01_RAW_UPLOADS.',
    '',
    '  Add more photos any time and press Finish again. Only the new ones are',
    '  worked on, so it takes seconds rather than minutes.',
    '',
    '  Wide photos are fitted rather than cropped when a tall shape is needed.',
    '  Cropping a whole room down to a phone screen throws away about two',
    '  thirds of it, which is a sliver of wall nobody can identify.',
    '',
  );
  return `${lines.join('\n')}\n`;
}


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

/**
 * The sheet's text, without deciding where it goes.
 *
 * Split out because the folder now lives on somebody's Mac and only n8n can
 * write there — so the CRM hands over the words and lets n8n put them on disk.
 * One builder, so the copy cannot drift between the two paths.
 */
export async function buildPropertyDetailsText(recordId: string): Promise<string | null> {
  const row = await db.queryOne<Row>(
    `SELECT r.label, p.* FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
      WHERE p.record_id = $1`,
    [recordId],
  );
  if (!row) return null;

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

  return `${lines.join('\n')}\n`;
}

/** Write it through a storage driver, for the deployments that can. */
export async function writePropertyDetails(
  driver: StorageDriver,
  recordId: string,
  folder: string,
): Promise<void> {
  const text = await buildPropertyDetailsText(recordId);
  if (!text) return;

  // In 00_PROPERTY_DATA rather than loose in the property root: the root is what
  // somebody opens on a phone in a lift, and it should show the numbered folders
  // in order, not a text file wedged above them.
  await driver.save(
    `${folder}/${PROPERTY_MEDIA_FOLDERS.data}/${DETAILS_FILE}`,
    Buffer.from(text, 'utf8'),
    'text/plain',
  );
}
