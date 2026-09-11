/**
 * Reading an .xlsx file, with nothing added to package.json.
 *
 * The owner's ask was "import from my Excel at one go", and what he has is
 * .xlsx — the file every desk in this business actually produces. Telling him
 * to Save As CSV first is a step that loses the accents in Indian names about
 * half the time (Excel's default CSV export is not UTF-8 on Windows) and one
 * more place for the import to go wrong before it starts.
 *
 * An .xlsx is a ZIP of XML. Node has the inflate half of ZIP built in
 * (`zlib.inflateRawSync`), so the whole reader is the central directory, three
 * entries out of it, and enough XML to walk a sheet. The alternative was a
 * dependency; `node_modules` is already 456 MB and the Render build has failed
 * for want of resources, so a hundred lines here is the cheaper trade.
 *
 * Deliberately not supported, because a CRM import does not need them:
 * formulas are read as their cached result and formatting is ignored. Anything
 * it cannot parse throws with a sentence
 * saying to save as CSV, which always works.
 */
import { inflateRawSync } from 'node:zlib';

interface ZipEntry { name: string; data: Buffer }

/** Every file in the archive, by name. */
function unzip(buf: Buffer): Map<string, Buffer> {
  // The end-of-central-directory record is at the end, after a comment of
  // unknown length, so it is found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65_536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found).');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra fields at its own lengths,
    // which are not always the central directory's — the data starts after
    // those, not after a fixed offset.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    entries.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return new Map(entries.map((e) => [e.name, e.data]));
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/** The shared string table — Excel stores repeated text once and indexes it. */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.match(/<si\b[\s\S]*?<\/si>|<si\b[^>]*\/>/g) ?? []) {
    // A string with mixed formatting is split across several <t> runs; they
    // concatenate. Ignore <rPh> (phonetic hints) — they are not the value.
    const runs = si.replace(/<rPh[\s\S]*?<\/rPh>/g, '').match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    out.push(runs.map((t) => decode(t.replace(/<t[^>]*>|<\/t>/g, ''))).join(''));
  }
  return out;
}

/**
 * Which cell styles mean "this is a date".
 *
 * Excel stores 15 March 2026 as the number 46096, and whether that is a date
 * or the number forty-six thousand is carried only by the cell's number
 * format. Without this, every date in the sheet imports as a five-digit
 * number — which validates cleanly and is silently wrong, the worst kind.
 */
function dateStyles(stylesXml: string): Set<number> {
  const dateFormats = new Set<number>([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    // A custom format is a date format if it mentions a date or time part and
    // no currency/percent marker.
    const code = decode(m[2]);
    if (/[dmyhs]/i.test(code.replace(/\[[^\]]*\]/g, '')) && !/[%$€₹]/.test(code)) {
      dateFormats.add(Number(m[1]));
    }
  }
  const out = new Set<number>();
  const cellXfs = stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/)?.[0] ?? '';
  let index = 0;
  for (const xf of cellXfs.match(/<xf\b[^>]*\/?>/g) ?? []) {
    const id = Number(xf.match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    if (dateFormats.has(id)) out.add(index);
    index++;
  }
  return out;
}

/** Excel's serial day number → ISO date. Day 1 is 1 January 1900. */
function serialToIso(serial: number): string {
  // Excel believes 1900 was a leap year; every date after 28 February 1900 is
  // one day ahead of reality, which the -2 corrects (1 for the phantom day,
  // 1 because the epoch is day 1 rather than day 0).
  const ms = Math.round((serial - 25_569) * 86_400_000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const iso = d.toISOString();
  // A whole number is a date; a fraction carries a time of day too.
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

/** "BC12" → 54 (zero-based). */
function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * The first worksheet, as a grid of trimmed strings.
 *
 * Same shape `parseCsv` returns, so the importer does not care which kind of
 * file it was handed.
 */
interface WorkbookSheet { name: string; path: string }

/** Workbook sheet names and XML parts, in Excel's displayed order. */
function workbookSheets(files: Map<string, Buffer>): WorkbookSheet[] {
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targets = new Map<string, string>();
  for (const relation of rels.match(/<Relationship\b[^>]*\/>/g) ?? []) {
    const id = relation.match(/\bId="([^"]+)"/)?.[1];
    const target = relation.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sheets: WorkbookSheet[] = [];
  for (const sheet of workbook.match(/<sheet\b[^>]*\/>/g) ?? []) {
    const name = decode(sheet.match(/\bname="([^"]*)"/)?.[1] ?? '');
    const id = sheet.match(/\br:id="([^"]+)"/)?.[1];
    const path = id ? targets.get(id) : undefined;
    if (name && path) sheets.push({ name, path });
  }
  return sheets;
}

/** Names of the sheets a user can select in an Excel import. */
export function xlsxSheetNames(buf: Buffer): string[] {
  return workbookSheets(unzip(buf)).map((sheet) => sheet.name);
}

/**
 * One worksheet, as a grid of trimmed strings. `sheetName` is optional for
 * compatibility: existing callers still get the workbook's first sheet.
 */
export function parseXlsx(buf: Buffer, sheetName?: string): { headers: string[]; rows: Record<string, string>[] } {
  const files = unzip(buf);

  // The workbook names its sheets; the relationship file says which XML part
  // each one is. Falling back to sheet1.xml covers files whose rels are
  // unusual, which is most of what Google Sheets exports.
  const sheets = workbookSheets(files);
  const selected = sheetName ? sheets.find((sheet) => sheet.name === sheetName) : sheets[0];
  if (sheetName && !selected) throw new Error(`Worksheet “${sheetName}” was not found.`);
  const sheetPath = selected?.path ?? 'xl/worksheets/sheet1.xml';

  const sheet = (files.get(sheetPath) ?? files.get('xl/worksheets/sheet1.xml'))?.toString('utf8');
  if (!sheet) throw new Error('That .xlsx has no readable worksheet. Save it as CSV and try again.');

  const strings = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '');
  const dates = dateStyles(files.get('xl/styles.xml')?.toString('utf8') ?? '');

  const grid: string[][] = [];
  for (const rowXml of sheet.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) ?? []) {
    const cells: string[] = [];
    for (const cellXml of rowXml.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) ?? []) {
      const ref = cellXml.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = cellXml.match(/\bt="([^"]+)"/)?.[1] ?? 'n';
      const style = Number(cellXml.match(/\bs="(\d+)"/)?.[1] ?? -1);
      const raw = cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1];
      const inline = cellXml.match(/<is>[\s\S]*?<\/is>/)?.[0];

      let value = '';
      if (type === 's' && raw !== undefined) value = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr' && inline) {
        value = (inline.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
          .map((t) => decode(t.replace(/<t[^>]*>|<\/t>/g, ''))).join('');
      } else if (type === 'b' && raw !== undefined) value = raw === '1' ? 'yes' : 'no';
      else if (raw !== undefined) {
        const n = Number(raw);
        value = dates.has(style) && Number.isFinite(n) && n > 0 ? serialToIso(n) : decode(raw);
      }

      // Blank cells are omitted from the XML entirely, so the position in the
      // row comes from the cell reference, never from the order they appear.
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value.trim();
    }
    grid.push(cells);
  }

  const nonEmpty = grid.filter((r) => r.some((v) => v !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { headers, rows };
}

/** True for a buffer that starts with the ZIP magic every .xlsx has. */
export function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05);
}
