/**
 * Devanagari → Latin, so a spoken note is always written in the script the
 * desk reads.
 *
 * The rule the owner set is that a note says "abhi client se baat hui h", never
 * "अभी क्लाइंट से बात हुई है" — the team writes Hinglish in Latin script all day
 * and a note in Devanagari is one nobody skims. Whisper, left to itself,
 * decides a Hindi-English sentence is Hindi and writes it in Devanagari perhaps
 * a third of the time, and the tidy-up model cannot be relied on to fix it:
 * `ANTHROPIC_API_KEY` is usually empty, the OpenRouter key can be exhausted,
 * and a model asked to transliterate sometimes translates instead.
 *
 * So this is the floor: no network, no key, no model, and a note still arrives
 * in Latin script. It is a phonetic transliteration rather than a translation —
 * the words stay the words the person said.
 *
 * Not IAST. Diacritics are what a transliteration standard is for and this is
 * for reading on a phone at a site gate, so it writes the way people type:
 * `aa` not `ā`, `sh` not `ś`, `t` for both त and ट.
 */

const VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};

/** Matras — the same vowels written after a consonant. */
const MATRAS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};

const CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'ळ': 'l',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  // Nukta forms, which is how Urdu-origin words in everyday Hindi are written.
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
};

const DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

const VIRAMA = '्';
const ANUSVARA = 'ं';
const CHANDRABINDU = 'ँ';
const VISARGA = 'ः';
const NUKTA = '़';

export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

/**
 * Transliterate every Devanagari run in `text`, leaving everything else — the
 * English half of a Hinglish sentence, the numbers, the names — untouched.
 */
export function toLatin(text: string): string {
  if (!hasDevanagari(text)) return text;

  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (DIGITS[ch]) { out += DIGITS[ch]; i += 1; continue; }
    if (VOWELS[ch]) { out += VOWELS[ch]; i += 1; continue; }

    // A consonant plus its nukta is one letter and has its own sound.
    const withNukta = text[i + 1] === NUKTA ? ch + NUKTA : null;
    const consonant = (withNukta && CONSONANTS[withNukta]) ? CONSONANTS[withNukta] : CONSONANTS[ch];
    if (consonant) {
      i += withNukta && CONSONANTS[withNukta] ? 2 : 1;
      out += consonant;
      const next = text[i];
      if (next === VIRAMA) {
        // Half consonant: no vowel at all, the next letter follows directly.
        i += 1;
      } else if (next && MATRAS[next]) {
        out += MATRAS[next];
        i += 1;
      } else {
        // The inherent 'a' every bare consonant carries — except at the end of
        // a word, where Hindi drops it. "काम" is kaam, not kaama.
        const atWordEnd = !text[i] || !/[ऀ-ॿ]/.test(text[i]!);
        if (!atWordEnd) out += 'a';
      }
      // A nasal after the syllable.
      if (text[i] === ANUSVARA || text[i] === CHANDRABINDU) {
        out += 'n';
        i += 1;
      }
      if (text[i] === VISARGA) { out += 'h'; i += 1; }
      continue;
    }

    if (ch === ANUSVARA || ch === CHANDRABINDU) { out += 'n'; i += 1; continue; }
    if (ch === VISARGA) { out += 'h'; i += 1; continue; }
    // Danda and double danda are full stops.
    if (ch === '।' || ch === '॥') { out += '.'; i += 1; continue; }
    if (ch === VIRAMA || ch === NUKTA) { i += 1; continue; }

    out += ch;
    i += 1;
  }
  return out;
}
