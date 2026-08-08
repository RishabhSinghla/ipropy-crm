/**
 * Post templates.
 *
 * Each is a function of (listing, brand, size) rather than a stored layout,
 * because the whole point is that a listing becomes a post without anyone
 * moving a text box: the template decides where things go, the data fills it,
 * and the studio is for the tweaks afterwards.
 *
 * Positions are expressed as fractions of the canvas so one template serves a
 * square post, a 4:5 portrait and a 9:16 story without three separate layouts.
 */
import { formatIndianPrice } from '@ipropy/shared';
import type { Design, Layer, Size } from './design';

export interface ListingData {
  title: string;
  subtitle: string;
  price: string;
  facts: string[];
  imageUrl: string | null;
}

export interface BrandData {
  name: string;
  colour: string;
  phone: string | null;
  tagline: string | null;
}

export interface TemplateDef {
  key: string;
  label: string;
  description: string;
  build: (listing: ListingData, brand: BrandData, size: Size) => Design;
}

let counter = 0;
const id = (): string => `l${(counter += 1)}`;

/** Readable on any photo: white on a dark fade rather than on the image itself. */
const WHITE = '#ffffff';

export const TEMPLATES: TemplateDef[] = [
  {
    key: 'photo_hero',
    label: 'Photo hero',
    description: 'Full-bleed photo, price and headline over a fade. The default for a new listing.',
    build: (listing, brand, size) => {
      const { width: w, height: h } = size;
      const pad = Math.round(w * 0.07);
      const layers: Layer[] = [];

      // Brand colour underneath *always*, with the photo over it. A gallery
      // entry can point at a file that no longer exists (the demo seed writes
      // URLs for files it never creates, and a real one can be deleted), and a
      // post that silently renders on near-black looks broken rather than
      // branded.
      layers.push({ id: id(), type: 'rect', x: 0, y: 0, w, h, fill: brand.colour });
      if (listing.imageUrl) {
        layers.push({ id: id(), type: 'image', x: 0, y: 0, w, h, src: listing.imageUrl, fit: 'cover' });
      }

      // The fade is what makes the text legible regardless of the photo.
      layers.push({
        id: id(), type: 'gradient', x: 0, y: Math.round(h * 0.42), w, h: Math.round(h * 0.58),
        from: 'rgba(2,6,23,0)', to: 'rgba(2,6,23,0.92)',
      });

      layers.push({
        id: id(), type: 'text', x: pad, y: Math.round(h * 0.55), w: w - pad * 2,
        text: listing.price, size: Math.round(w * 0.095), color: WHITE, weight: 800, lineHeight: 1.05,
      });
      layers.push({
        id: id(), type: 'text', x: pad, y: Math.round(h * 0.55) + Math.round(w * 0.115), w: w - pad * 2,
        text: listing.title, size: Math.round(w * 0.052), color: WHITE, weight: 700, lineHeight: 1.15,
      });
      layers.push({
        id: id(), type: 'text', x: pad, y: Math.round(h * 0.55) + Math.round(w * 0.115) + Math.round(w * 0.075), w: w - pad * 2,
        text: listing.subtitle, size: Math.round(w * 0.032), color: 'rgba(255,255,255,0.82)', weight: 500, lineHeight: 1.3,
      });
      if (listing.facts.length) {
        layers.push({
          id: id(), type: 'text', x: pad, y: h - pad - Math.round(w * 0.075), w: w - pad * 2,
          text: listing.facts.join('  ·  '), size: Math.round(w * 0.028), color: 'rgba(255,255,255,0.9)', weight: 600,
        });
      }

      layers.push(brandBar(brand, size, pad));
      return { size, background: '#020617', layers };
    },
  },

  {
    key: 'split',
    label: 'Split card',
    description: 'Photo on top, details on a clean panel below. Reads well when the photo is busy.',
    build: (listing, brand, size) => {
      const { width: w, height: h } = size;
      const pad = Math.round(w * 0.07);
      const photoH = Math.round(h * 0.56);
      const layers: Layer[] = [];

      layers.push({ id: id(), type: 'rect', x: 0, y: 0, w, h: photoH, fill: brand.colour });
      if (listing.imageUrl) {
        layers.push({ id: id(), type: 'image', x: 0, y: 0, w, h: photoH, src: listing.imageUrl, fit: 'cover' });
      }
      layers.push({ id: id(), type: 'rect', x: 0, y: photoH, w, h: h - photoH, fill: '#ffffff' });

      layers.push({
        id: id(), type: 'text', x: pad, y: photoH + pad, w: w - pad * 2,
        text: listing.title, size: Math.round(w * 0.05), color: '#0f172a', weight: 700, lineHeight: 1.15,
      });
      layers.push({
        id: id(), type: 'text', x: pad, y: photoH + pad + Math.round(w * 0.075), w: w - pad * 2,
        text: listing.subtitle, size: Math.round(w * 0.03), color: '#475569', weight: 500,
      });
      layers.push({
        id: id(), type: 'text', x: pad, y: photoH + pad + Math.round(w * 0.125), w: w - pad * 2,
        text: listing.price, size: Math.round(w * 0.08), color: brand.colour, weight: 800,
      });
      if (listing.facts.length) {
        layers.push({
          id: id(), type: 'text', x: pad, y: h - pad - Math.round(w * 0.055), w: w - pad * 2,
          text: listing.facts.join('  ·  '), size: Math.round(w * 0.026), color: '#64748b', weight: 600,
        });
      }

      layers.push({
        id: id(), type: 'text', x: pad, y: h - pad - Math.round(w * 0.02), w: w - pad * 2,
        text: brand.name.toUpperCase(), size: Math.round(w * 0.022), color: brand.colour, weight: 700, letterSpacing: 2,
      });
      return { size, background: '#ffffff', layers };
    },
  },

  {
    key: 'price_drop',
    label: 'Announcement',
    description: 'Bold type on brand colour. For a price change, a launch or a sold-out post.',
    build: (listing, brand, size) => {
      const { width: w, height: h } = size;
      const pad = Math.round(w * 0.08);
      const layers: Layer[] = [
        { id: id(), type: 'rect', x: 0, y: 0, w, h, fill: brand.colour },
        {
          id: id(), type: 'text', x: pad, y: Math.round(h * 0.3), w: w - pad * 2,
          text: 'NEW LAUNCH', size: Math.round(w * 0.035), color: 'rgba(255,255,255,0.75)', weight: 700, letterSpacing: 6,
        },
        {
          id: id(), type: 'text', x: pad, y: Math.round(h * 0.36), w: w - pad * 2,
          text: listing.title, size: Math.round(w * 0.085), color: WHITE, weight: 800, lineHeight: 1.08,
        },
        {
          id: id(), type: 'text', x: pad, y: Math.round(h * 0.58), w: w - pad * 2,
          text: listing.price, size: Math.round(w * 0.065), color: WHITE, weight: 700,
        },
        {
          id: id(), type: 'text', x: pad, y: Math.round(h * 0.66), w: w - pad * 2,
          text: listing.subtitle, size: Math.round(w * 0.03), color: 'rgba(255,255,255,0.8)', weight: 500, lineHeight: 1.35,
        },
      ];
      layers.push(brandBar(brand, size, pad, WHITE));
      return { size, background: brand.colour, layers };
    },
  },
];

/** The line every post ends with: who to call. */
function brandBar(brand: BrandData, size: Size, pad: number, colour = WHITE): Layer {
  const parts = [brand.name, brand.phone].filter(Boolean) as string[];
  return {
    id: id(),
    type: 'text',
    x: pad,
    y: size.height - pad - Math.round(size.width * 0.028),
    w: size.width - pad * 2,
    text: parts.join('   ·   '),
    size: Math.round(size.width * 0.024),
    color: colour === WHITE ? 'rgba(255,255,255,0.72)' : colour,
    weight: 600,
    letterSpacing: 1,
  };
}

/** Turn a property record from the public/records API into template input. */
export function listingFromProperty(
  record: Record<string, unknown>,
  display: Record<string, string> | undefined,
  imageUrl: string | null,
): ListingData {
  const price = Number(record.total_price ?? record.base_price ?? 0);
  const facts: string[] = [];
  if (record.configuration) facts.push(String(record.configuration));
  if (record.carpet_area) facts.push(`${record.carpet_area} sq ft carpet`);
  if (record.facing) facts.push(`${record.facing} facing`);
  if (record.floor) facts.push(`Floor ${record.floor}`);

  const locality = [record.locality, record.city].filter(Boolean).join(', ');
  const project = display?.project_id ?? record.project_name ?? '';

  return {
    title: String(record.name ?? record.unit_number ?? 'Property'),
    subtitle: [project, locality].filter(Boolean).join(' · ') || 'Available now',
    price: price > 0 ? formatIndianPrice(price) : 'Price on request',
    facts: facts.slice(0, 4),
    imageUrl,
  };
}
