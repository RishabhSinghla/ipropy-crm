/**
 * Non-destructive property image factory.
 *
 * The uploaded original is read only. Every output is a new object filed into
 * the property's OneDrive-style folder tree, and the familiar thumb/medium/
 * large variant names stay intact so existing CRM and website consumers do not
 * need to know the storage layout changed.
 */
import sharp from 'sharp';
import type { StorageDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import {
  derivativeStorageKey, PROPERTY_MEDIA_FOLDERS,
} from '../storage/keys.js';

interface Derivative {
  key: string;
  destination: string;
  suffix: string;
  width?: number;
  height?: number;
  quality?: number;
  lossless?: boolean;
}

const PROPERTY_DERIVATIVES: Derivative[] = [
  // Full decoded pixels, losslessly re-packed as WebP. The camera original is
  // still the true master in 01 Originals and is never rewritten.
  { key: 'compressed', destination: PROPERTY_MEDIA_FOLDERS.compressed, suffix: 'lossless', lossless: true },

  // Platform-ready canvases. `contain` below never crops a room to force a
  // ratio; any spare area gets a quiet neutral background.
  { key: 'instagramFeed', destination: PROPERTY_MEDIA_FOLDERS.instagramFeed, suffix: 'instagram-feed', width: 1080, height: 1350, quality: 86 },
  { key: 'instagramStory', destination: PROPERTY_MEDIA_FOLDERS.instagramStory, suffix: 'instagram-story', width: 1080, height: 1920, quality: 86 },
  { key: 'facebook', destination: PROPERTY_MEDIA_FOLDERS.facebook, suffix: 'facebook', width: 1200, height: 630, quality: 84 },
  { key: 'whatsapp', destination: PROPERTY_MEDIA_FOLDERS.whatsapp, suffix: 'whatsapp', width: 1080, height: 1350, quality: 78 },

  // Existing public contract: website and CRM continue asking for these names.
  { key: 'thumb', destination: PROPERTY_MEDIA_FOLDERS.crmWebsite, suffix: 'thumb', width: 480, quality: 76 },
  { key: 'medium', destination: PROPERTY_MEDIA_FOLDERS.crmWebsite, suffix: 'medium', width: 1200, quality: 82 },
  { key: 'large', destination: PROPERTY_MEDIA_FOLDERS.crmWebsite, suffix: 'large', width: 1600, quality: 84 },
];

/** Preserve the old lightweight behaviour for avatars and non-property files. */
const STANDARD_DERIVATIVES: Derivative[] = [
  { key: 'thumb', destination: '', suffix: 'thumb', width: 480, quality: 76 },
  { key: 'medium', destination: '', suffix: 'medium', width: 1200, quality: 82 },
  { key: 'large', destination: '', suffix: 'large', width: 2400, quality: 82 },
];

export async function processImage(
  driver: StorageDriver,
  attachmentId: string,
  storageKey: string,
  original: Buffer,
  profile: 'property' | 'standard' = 'standard',
): Promise<Record<string, string> | null> {
  try {
    const meta = await sharp(original, { failOn: 'none' }).rotate().metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions in decoded metadata');
  } catch (err) {
    logger.warn({ err, attachmentId }, 'media job: image decode failed — serving original only');
    return null;
  }

  const variants: Record<string, string> = {};
  const derivatives = profile === 'property' ? PROPERTY_DERIVATIVES : STANDARD_DERIVATIVES;
  for (const derivative of derivatives) {
    let transform = sharp(original, { failOn: 'none' }).rotate();
    if (derivative.width && derivative.height) {
      transform = transform.resize(derivative.width, derivative.height, {
        fit: 'contain',
        withoutEnlargement: true,
        background: { r: 247, g: 245, b: 242, alpha: 1 },
      });
    } else if (derivative.width) {
      transform = transform.resize({ width: derivative.width, withoutEnlargement: true });
    }

    const rendered = await transform
      .webp(derivative.lossless
        ? { lossless: true, effort: 5 }
        : { quality: derivative.quality ?? 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    const output = rendered.data;

    const key = derivative.destination
      ? derivativeStorageKey(storageKey, derivative.destination, derivative.suffix, '.webp')
      : `${storageKey.slice(0, storageKey.lastIndexOf('.') > -1 ? storageKey.lastIndexOf('.') : storageKey.length)}-${derivative.suffix}.webp`;
    await driver.save(key, output, 'image/webp');
    variants[derivative.key] = key;
  }

  return variants;
}
