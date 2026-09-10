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
export const DESCRIPTIONS_FILE = 'DESCRIPTIONS.txt';

/**
 * The map from a shape to every place that shape belongs.
 *
 * Only places this business actually sells through. Threads, Pinterest, TikTok,
 * Telegram and Snapchat were removed on the owner's instruction: a line naming
 * a platform nobody posts to is a line somebody has to read and dismiss every
 * single time, and the file only works if every line earns its place.
 *
 * It names the exact post type rather than the app, because "Instagram" is
 * useless when Instagram has a feed, a reel and a story that do not want the
 * same shape.
 */
const WHERE_TO_POST: { folder: string; size: string; uses: string[] }[] = [
  {
    folder: '{p}-SHAPES/4x5',
    size: '1080 x 1350 — tall. The one you will use most',
    uses: [
      'Instagram  ->  feed photo, feed carousel, feed video cover',
      'Facebook   ->  page post, profile post, group post, photo album',
      'LinkedIn   ->  photo post, multiple photo post',
      'WhatsApp   ->  sending in a chat or a group',
    ],
  },
  {
    folder: '{p}-SHAPES/9x16',
    size: '1080 x 1920 — full phone screen, top to bottom',
    uses: [
      'Instagram  ->  reel cover, story, story with a link, highlight',
      'Facebook   ->  reel, page reel, story, page story',
      'YouTube    ->  short',
      'WhatsApp   ->  status photo, status video',
    ],
  },
  {
    folder: '{p}-SHAPES/4x3',
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
    folder: '{p}-SHAPES/1x1',
    size: '1080 x 1080 — square',
    uses: [
      'Google Business  ->  business update, offer post, event post, product',
      'X (Twitter)      ->  post, multiple image post',
      'Instagram        ->  feed, when you want square instead of tall',
      'YouTube          ->  community post',
    ],
  },
  {
    folder: '{p}-SHAPES/16x9',
    size: '1920 x 1080 — widescreen, like a television',
    uses: [
      'YouTube      ->  video thumbnail, playlist cover',
      'Your website ->  page hero image, blog article, locality guide',
      'LinkedIn     ->  article image, newsletter image',
      'Facebook     ->  link preview image',
    ],
  },
  {
    folder: '{p}-EDITED/WATERMARKED',
    size: 'full size, with the iPropy logo on it',
    uses: [
      'Anywhere you are worried about the photo being taken and reused.',
      'Portals and marketplace listings are the usual reason.',
    ],
  },
  {
    folder: '{p}-VIDEO',
    size: 'your walkthrough, made vertical',
    uses: [
      '<name>-9x16.mp4  ->  instagram reel, facebook reel, youtube short,',
      '                     whatsapp status, instagram and facebook stories',
    ],
  },
];

/**
 * One file per property holding everything you have to type somewhere else.
 *
 * Three pieces of text rather than one per platform. Six versions of the same
 * facts is work that produces sameness, and a portal description and an
 * Instagram caption genuinely are different jobs, so those two do not share
 * wording. Title, description, caption and hashtags cover every place in the
 * map below.
 *
 * Written with a model when one is configured, and from the record's own facts
 * when not: correct and a little wooden beats an empty file.
 */
export function descriptionsText(unit: string, facts: string[], text: {
  title: string; description: string; caption: string; hashtags: string;
  /** One per portal, because the three of them want different things. */
  portals?: { name: string; note: string; body: string }[];
  /** The caption again, for the half of every forward that reads Hindi. */
  hindi?: { caption: string; description: string };
}): string {
  const lines: string[] = [
    `${unit} — WHAT TO POST, AND WHERE`,
    '='.repeat(64),
    '',
    'TITLE',
    '-'.repeat(64),
    'Portal listing title, YouTube title, the first line of a post.',
    '',
    `  ${text.title}`,
    '',
    'DESCRIPTION',
    '-'.repeat(64),
    'Portals, Marketplace, your website. This is the one Google reads.',
    '',
    ...text.description.split('\n').map((l) => `  ${l}`),
    '',
    'CAPTION',
    '-'.repeat(64),
    'Instagram, Facebook, WhatsApp. Short, and sounds like a person.',
    '',
    ...text.caption.split('\n').map((l) => `  ${l}`),
    '',
    'HASHTAGS',
    '-'.repeat(64),
    'Social only. Never put these on a portal listing.',
    '',
    `  ${text.hashtags}`,
    '',
  ];

  // One version per portal, because they genuinely are different jobs. 99acres
  // rewards density, Housing rewards locality and lifestyle, Magicbricks wants
  // a short opener and bullets. Pasting one paragraph into all three is how a
  // listing ends up middling everywhere.
  for (const portal of text.portals ?? []) {
    lines.push(
      portal.name.toUpperCase(),
      '-'.repeat(64),
      portal.note,
      '',
      ...portal.body.split('\n').map((l) => `  ${l}`),
      '',
    );
  }

  if (text.hindi?.caption || text.hindi?.description) {
    lines.push(
      'HINDI',
      '-'.repeat(64),
      'The same thing in Hindi, for WhatsApp forwards. Pick whichever suits who you are sending to.',
      '',
      ...(text.hindi.caption ? [...text.hindi.caption.split('\n').map((l) => `  ${l}`), ''] : []),
      ...(text.hindi.description ? [...text.hindi.description.split('\n').map((l) => `  ${l}`), ''] : []),
    );
  }

  lines.push(
    'THE FACTS',
    '-'.repeat(64),
    ...facts.map((l) => `  ${l}`),
    '',
    '',
    'WHICH FOLDER GOES WHERE',
    '='.repeat(64),
    '',
    'Every photo has been made in several shapes. Folders are named after the',
    'shape rather than the app, because the same shape is used in several',
    'places and one copy is easier to keep straight than five.',
    '',
  );

  for (const entry of WHERE_TO_POST) {
    lines.push('-'.repeat(64), entry.folder.replace('{p}', unit), `  ${entry.size}`, '');
    for (const use of entry.uses) lines.push(`  ${use}`);
    lines.push('');
  }

  lines.push(
    '-'.repeat(64),
    'WORTH KNOWING',
    '',
    `  Your originals are never touched. They stay exactly as they came off`,
    `  the camera, in ${unit}-RAW-UPLOADS.`,
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
  { key: 'bedrooms', label: 'Bedrooms' },
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
    `${folder}/${DETAILS_FILE}`,
    Buffer.from(text, 'utf8'),
    'text/plain',
  );
}


/**
 * The three portals this business actually lists on, and what each wants.
 *
 * Not a general list of every portal in India. Adding one here adds a section
 * to every descriptions file and a paragraph a model has to write, and a
 * section nobody reads is worse than no section.
 */
export const PORTALS: { name: string; note: string; brief: string }[] = [
  {
    name: '99acres',
    note: 'Facts dense and specific. 800 to 1200 characters. No adjectives it cannot back up.',
    brief: 'Dense and factual, 800-1200 characters, specification-led. Lead with configuration, area and '
      + 'possession. No lifestyle language, no adjectives that cannot be verified from the photographs.',
  },
  {
    name: 'Housing.com',
    note: 'Locality and lifestyle. What living here is actually like.',
    brief: 'Locality-led, 700-1000 characters, warmer. Open with the neighbourhood and what is around it, '
      + 'then the flat. Only name landmarks given in the facts.',
  },
  {
    name: 'Magicbricks',
    note: 'Short punchy opener, then bullets. Scanned, not read.',
    brief: 'A two-line opener, then six to eight short bullet points. Scanned on a phone, not read.',
  },
];

/**
 * The property's facts as data rather than as a text file.
 *
 * The same list the details file prints, handed to whatever needs to *reason*
 * about the property instead of display it — the vision pass that writes
 * captions, above all. A model told only "here are 25 photos" writes a caption
 * about a nice room; told the unit is a 4 BHK builder floor on 250 square yards
 * in Greenfield Colony at 1.45 Cr, it writes the one somebody would answer.
 */
export async function propertyFacts(recordId: string): Promise<Record<string, string>> {
  const row = await db.queryOne<Row>(
    `SELECT r.label, r.record_number, p.* FROM ipy_e_properties p
       JOIN ipy_record r ON r.id = p.record_id WHERE p.record_id = $1`,
    [recordId],
  );
  if (!row) return {};

  const facts: Record<string, string> = {};
  for (const f of FIELDS) {
    const raw = row[f.key];
    if (raw === null || raw === undefined || raw === '') continue;
    // A price of zero means nobody has filled it in, not that the floor is
    // free. These facts are printed onto the title card of the reel and the
    // walkthrough, so letting a 0 through puts "₹0" on a marketing video — and
    // both properties on the live site are priced 0 right now. Leaving the fact
    // out entirely makes the card fall back to the layout without a price,
    // which is the honest version of not knowing.
    if (f.money && typeof raw === 'number' && raw <= 0) continue;
    const value = f.money && typeof raw === 'number'
      ? formatIndianPrice(raw)
      : Array.isArray(raw) ? raw.join(', ') : String(raw);
    if (value.trim()) facts[f.label] = value.trim();
  }
  return facts;
}

/**
 * The descriptions file for one property, ready to write.
 *
 * The three texts come from the record's own facts today. With a model
 * configured they would be written properly per purpose; until then this is
 * correct and a little wooden, which beats an empty file somebody has to fill
 * in by hand for every property.
 */
export async function buildDescriptions(recordId: string): Promise<string> {
  const row = await db.queryOne<Row>(
    `SELECT r.label, r.record_number, p.* FROM ipy_e_properties p
       JOIN ipy_record r ON r.id = p.record_id WHERE p.record_id = $1`,
    [recordId],
  );
  if (!row) return '';

  const unit = String(row.label ?? 'PROPERTY').split(/\s+/)[0]!.toUpperCase();
  const facts: string[] = [];
  for (const f of FIELDS) {
    const raw = row[f.key];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = f.money && typeof raw === 'number'
      ? formatIndianPrice(raw)
      : Array.isArray(raw) ? raw.join(', ') : String(raw);
    if (value.trim()) facts.push(line(f.label, value));
  }

  const bits = [row.configuration, row.property_type, row.locality, row.city]
    .filter((v): v is string => Boolean(v && String(v).trim()));
  const price = typeof row.base_price === 'number' ? formatIndianPrice(row.base_price) : null;

  const headline = [bits.join(' '), price ? `at ${price}` : null].filter(Boolean).join(' ');
  // Placeholders the media worker replaces once a model has looked at the
  // photographs. Written now rather than left out, so a folder opened before
  // processing still has the shape of the file and somebody can see what is
  // coming rather than an empty page.
  return descriptionsText(unit, facts, {
    title: headline || String(row.label ?? 'Property'),
    description: facts.join('\n') || 'Add the property details in the CRM and this fills in.',
    caption: headline ? `${headline}. Message us for the floor plan and a visit.` : 'Message us for details.',
    hashtags: '#faridabad #realestate #property #builderfloor #greenfieldcolony',
    portals: PORTALS.map((p) => ({
      name: p.name,
      note: p.note,
      body: 'Written once the photographs have been looked at.',
    })),
    hindi: { caption: 'Written once the photographs have been looked at.', description: '' },
  });
}
