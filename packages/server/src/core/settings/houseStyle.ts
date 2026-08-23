/**
 * How this business sounds, in one place, editable without a deploy.
 *
 * Every prompt in the media pipeline used to carry its own opinion about tone:
 * how a caption should read, what a voiceover should sound like, what the model
 * must never claim to see. Five prompts across three files, and changing "sound
 * less like a brochure" meant editing all five and shipping.
 *
 * Now the prompts carry the *task* and this carries the *voice*. Change the box,
 * every caption in the business changes with it.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

export interface HouseStyle {
  /** Facts a model must never assert. The one rule that keeps listings honest. */
  neverMention: string;
  captionTone: string;
  voiceLanguage: string;
  musicBrief: string;
  signOff: string;
}

const FALLBACK: HouseStyle = {
  neverMention:
    'Furniture, fittings, appliances, views, greenery or finishes that are not visible in the photograph. '
    + 'Never guess a floor number, a direction, an area or a price. An empty room is an empty room and saying so is correct.',
  captionTone: 'Sounds like a person, not a brochure. Indian English. One emoji at most. Never more than five lines.',
  voiceLanguage:
    'Hinglish. Natural spoken Hindi-English mixing, the way a Delhi NCR property consultant talks to a client. '
    + 'Written in Latin script, not Devanagari.',
  musicBrief:
    'Calm, elegant, understated instrumental for a luxury property tour. Warm piano or soft strings with a light '
    + 'steady pulse. No drums that dominate, no build to a drop, nothing dramatic. It should sit under a speaking voice.',
  signOff: 'Message us for the floor plan and a site visit.',
};

const KEYS: Record<keyof HouseStyle, string> = {
  neverMention: 'house_style.never_mention',
  captionTone: 'house_style.caption_tone',
  voiceLanguage: 'house_style.voice_language',
  musicBrief: 'house_style.music_brief',
  signOff: 'house_style.sign_off',
};

let cached: HouseStyle | null = null;

export function invalidateHouseStyle(): void {
  cached = null;
}

export async function houseStyle(): Promise<HouseStyle> {
  if (cached) return cached;
  try {
    const rows = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM ipy_setting WHERE key = ANY($1)`,
      [Object.values(KEYS)],
    );
    const map = new Map(rows.rows.map((r) => [r.key, r.value]));
    const read = (k: keyof HouseStyle): string => {
      const raw = map.get(KEYS[k]);
      const value = typeof raw === 'string' ? raw.trim() : '';
      // An emptied box means "use the default", not "say nothing". Blanking the
      // never-mention rule would otherwise be one keystroke away from a model
      // furnishing an empty builder floor.
      return value.length > 2 ? value : FALLBACK[k];
    };
    cached = {
      neverMention: read('neverMention'),
      captionTone: read('captionTone'),
      voiceLanguage: read('voiceLanguage'),
      musicBrief: read('musicBrief'),
      signOff: read('signOff'),
    };
    return cached;
  } catch (err) {
    logger.warn({ err }, 'could not read house style, using defaults');
    return FALLBACK;
  }
}
