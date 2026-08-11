/**
 * When a photo was actually taken, as opposed to when it finished uploading.
 *
 * These differ by hours, and that gap is the whole reason this file exists. The
 * phone shoots at a site with no signal and the bytes arrive that evening over
 * wi-fi; matching on upload time would file the entire day against whichever
 * property happened to sync last.
 *
 * The hard part is not reading the tag — it is the timezone.
 *
 * EXIF `DateTimeOriginal` is local wall-clock time with no offset attached:
 * "2026:08:11 09:03:00" means nine in the morning wherever the photographer was
 * standing, and the tag itself does not say where that was. Read as UTC in
 * India, every photo lands five and a half hours early — which in a day of site
 * visits is not a rounding error, it is one or two properties' worth of drift,
 * and photos file against the wrong builder floor.
 *
 * So the offset is resolved in this order:
 *
 *   1. `OffsetTimeOriginal` — the EXIF 2.31 tag that records the actual offset.
 *      Modern iPhones write it, and when it is there it is authoritative.
 *   2. The organisation's configured timezone (`org.timezone`), which is where
 *      the team is, and is right for every shoot that is not on a work trip.
 *   3. UTC, and only as a last resort.
 *
 * Video is a different story with an easier ending: ffprobe's
 * `format.tags.creation_time` is normally already ISO-8601 with a zone, because
 * the MP4 spec stores UTC. It is parsed as-is rather than being offset again.
 */
import sharp from 'sharp';
import exifReader from 'exif-reader';
import ffmpeg from 'fluent-ffmpeg';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/** Cached because it is read per attachment and changes about never. */
let orgTimezone: { value: string; readAt: number } | null = null;
const TZ_TTL_MS = 5 * 60_000;

export async function organisationTimezone(): Promise<string> {
  if (orgTimezone && Date.now() - orgTimezone.readAt < TZ_TTL_MS) return orgTimezone.value;
  const row = await db.queryOne<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.timezone'`,
  );
  const value = row?.value || 'Asia/Kolkata';
  orgTimezone = { value, readAt: Date.now() };
  return value;
}

/**
 * The offset a timezone was at on a given date, in minutes.
 *
 * Computed from `Intl` rather than hardcoded, so it stays correct for a team
 * that is not in India and across a daylight-saving boundary — a photo taken in
 * July and one taken in December do not share an offset in most of the world.
 */
export function offsetMinutesAt(timeZone: string, utcDate: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(dtf.formatToParts(utcDate).map((p) => [p.type, p.value]));
    // `hour` can come back as "24" for midnight in some ICU versions.
    const hour = parts.hour === '24' ? '00' : parts.hour;
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(hour), Number(parts.minute), Number(parts.second),
    );
    return Math.round((asUtc - utcDate.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

/** `"+05:30"` → 330. Returns null for anything that is not an offset. */
export function parseOffset(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * `"2026:08:11 09:03:00"` plus an offset in minutes → a real instant.
 *
 * exif-reader hands back a JS Date built by treating the tag as UTC, which is
 * the convention but not the truth. Undoing that and reapplying the real offset
 * is what makes the result an actual moment rather than a number that looks
 * like one.
 */
export function applyOffset(naiveAsUtc: Date, offsetMinutes: number): Date {
  return new Date(naiveAsUtc.getTime() - offsetMinutes * 60_000);
}

interface ExifTags {
  Photo?: { DateTimeOriginal?: Date; OffsetTimeOriginal?: string; DateTimeDigitized?: Date };
  Image?: { DateTime?: Date };
}

/**
 * Capture time from an image's EXIF.
 *
 * Null when the file has no EXIF at all — a screenshot, a WhatsApp forward, an
 * image someone pasted. That is correct and deliberate: an unknown capture time
 * must stay unknown. Substituting the upload time would file it confidently
 * against whichever property was being visited when it happened to sync, which
 * is worse than leaving it unfiled for somebody to place by hand.
 */
export async function captureTimeFromImage(buffer: Buffer): Promise<Date | null> {
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    if (!meta.exif) return null;

    const tags = exifReader(meta.exif) as ExifTags;
    const naive = tags.Photo?.DateTimeOriginal ?? tags.Photo?.DateTimeDigitized ?? tags.Image?.DateTime;
    if (!naive || Number.isNaN(naive.getTime())) return null;

    const explicit = parseOffset(tags.Photo?.OffsetTimeOriginal);
    if (explicit !== null) return applyOffset(naive, explicit);

    // No offset recorded. Assume the team's own timezone, resolved for roughly
    // the right date so a daylight-saving boundary does not shift it an hour.
    const tz = await organisationTimezone();
    return applyOffset(naive, offsetMinutesAt(tz, naive));
  } catch (err) {
    logger.debug({ err }, 'capture time: EXIF unreadable');
    return null;
  }
}

/** Capture time from a video container. Already zoned, so taken at face value. */
export async function captureTimeFromVideo(path: string): Promise<Date | null> {
  try {
    const created = await new Promise<string | undefined>((resolve, reject) => {
      ffmpeg.ffprobe(path, (err, data) => {
        if (err) return reject(err);
        const tags = (data.format?.tags ?? {}) as Record<string, string>;
        resolve(tags.creation_time ?? tags['com.apple.quicktime.creationdate']);
      });
    });
    if (!created) return null;
    const parsed = new Date(created);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch (err) {
    logger.debug({ err }, 'capture time: video metadata unreadable');
    return null;
  }
}
