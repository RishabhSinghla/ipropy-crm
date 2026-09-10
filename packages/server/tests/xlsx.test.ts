/**
 * Reading an .xlsx without a dependency.
 *
 * The owner asked to import "from my Excel at one go", and the reader is a
 * hundred lines of ZIP and XML rather than a package, because `node_modules`
 * is already 456 MB and the Render build has failed for want of resources.
 * The trade only holds if the hundred lines are right, so the shapes that
 * actually break a spreadsheet reader are pinned here:
 *
 *   * a date, which Excel stores as the number 46096 and nothing else;
 *   * a blank cell, which is *absent from the XML* rather than empty, so a
 *     reader that trusts cell order silently shifts a whole row left;
 *   * a string split into runs by formatting, which arrives as several <t>
 *     elements that have to be joined;
 *   * XML entities, in a business whose unit names contain "&" and "—".
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { looksLikeXlsx, parseXlsx } from '../src/utils/xlsx.js';

/** A minimal ZIP writer — enough to build the workbook these tests read back. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);                 // deflate
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const entry = Buffer.alloc(46 + nameBuf.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBuf.copy(entry, 46);
    central.push(entry);

    offset += local.length + data.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const SHARED = `<?xml version="1.0"?><sst>
  <si><t>Name</t></si><si><t>Locality</t></si><si><t>Possession</t></si><si><t>Price</t></si>
  <si><t>Sh&amp;ilpa &#x2014; A-101</t></si>
  <si><r><t>Sec</t></r><r><t>tor 21</t></r></si>
</sst>`;

const STYLES = `<?xml version="1.0"?><styleSheet>
  <numFmts><numFmt numFmtId="165" formatCode="dd-mm-yyyy"/></numFmts>
  <cellXfs><xf numFmtId="0"/><xf numFmtId="165"/></cellXfs>
</styleSheet>`;

// Row 3 has no cell for column B at all — the gap a real spreadsheet leaves.
const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
  <row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2" s="1"><v>46096</v></c><c r="D2"><v>7500000</v></c></row>
  <row r="3"><c r="A3" t="inlineStr"><is><t>Tower B</t></is></c><c r="C3" s="1"><v>45000</v></c><c r="D3"><v>4250000.5</v></c></row>
</sheetData></worksheet>`;

const BOOK = zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Units" r:id="rId7"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId7" Target="worksheets/sheet7.xml"/></Relationships>',
  'xl/sharedStrings.xml': SHARED,
  'xl/styles.xml': STYLES,
  'xl/worksheets/sheet7.xml': SHEET,
});

describe('parseXlsx', () => {
  it('recognises a workbook by its bytes, not its name', () => {
    expect(looksLikeXlsx(BOOK)).toBe(true);
    expect(looksLikeXlsx(Buffer.from('Name,Locality\nA,B\n'))).toBe(false);
  });

  it('reads the first row as headers', () => {
    expect(parseXlsx(BOOK).headers).toEqual(['Name', 'Locality', 'Possession', 'Price']);
  });

  it('follows the workbook relationship to the real sheet', () => {
    // Named sheet7.xml, not sheet1.xml. A reader that assumes the filename
    // reads an empty workbook and reports "no data rows" on a full file.
    expect(parseXlsx(BOOK).rows).toHaveLength(2);
  });

  it('joins a string split into formatting runs, and decodes entities', () => {
    const [first] = parseXlsx(BOOK).rows;
    expect(first.Name).toBe('Sh&ilpa — A-101');
    expect(first.Locality).toBe('Sector 21');
  });

  it('turns a date-formatted serial into a date', () => {
    // 46096 is 15 March 2026. Without the style lookup it imports as the
    // number, which validates cleanly and is silently wrong.
    expect(parseXlsx(BOOK).rows[0].Possession).toBe('2026-03-15');
  });

  it('keeps numbers as numbers, decimals included', () => {
    const rows = parseXlsx(BOOK).rows;
    expect(rows[0].Price).toBe('7500000');
    expect(rows[1].Price).toBe('4250000.5');
  });

  it('leaves an omitted cell blank instead of shifting the row', () => {
    // Row 3 has no B cell. The date must stay under Possession, not slide
    // into Locality — which is how a whole import lands one column out.
    const [, second] = parseXlsx(BOOK).rows;
    expect(second.Name).toBe('Tower B');
    expect(second.Locality).toBe('');
    expect(second.Possession).toBe('2023-03-15');
  });
});
