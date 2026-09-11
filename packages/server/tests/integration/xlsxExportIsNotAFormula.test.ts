/**
 * The XLSX half of the same promise, checked against a real file.
 *
 * ExcelJS writes a plain string as a string cell — a formula needs
 * `{ formula: … }` — so a contact called `=1+1` lands in sharedStrings as text
 * and no `<f>` element is written at all. True today, entirely the library's
 * doing, and it would go away silently on a version bump or the day somebody
 * sets a cell value from a parsed expression.
 *
 * Asserted on the bytes rather than on ExcelJS's own reader, because the
 * question is what Excel will find in the file.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { inflateRawSync } from 'node:zlib';

let app: ReturnType<typeof createApp>;
let token = '';
let recordId = '';
const NAME = `=1+1+QA${Date.now().toString(36)}`;

/** The one entry we need out of the zip, without adding a dependency for it. */
function entry(zip: Buffer, wanted: string): string | null {
  let at = 0;
  while (at < zip.length - 4) {
    if (zip.readUInt32LE(at) !== 0x04034b50) { at += 1; continue; }
    const method = zip.readUInt16LE(at + 8);
    const compressed = zip.readUInt32LE(at + 18);
    const nameLen = zip.readUInt16LE(at + 26);
    const extraLen = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen + extraLen;
    if (name === wanted && compressed > 0) {
      const body = zip.subarray(start, start + compressed);
      return method === 8 ? inflateRawSync(body).toString('utf8') : body.toString('utf8');
    }
    at = start + (compressed || 1);
  }
  return null;
}

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;
  const made = await request(app).post('/api/records/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ full_name: NAME, mobile: `69${String(Date.now()).slice(-8)}` });
  recordId = made.body.id;
});

describe('the XLSX export', () => {
  it('writes a name beginning with = as text, never as a formula', async () => {
    const res = await request(app).post('/api/records/leads/export')
      .set('Authorization', `Bearer ${token}`)
      .send({ format: 'xlsx' })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const zip = res.body as Buffer;

    const strings = entry(zip, 'xl/sharedStrings.xml') ?? '';
    expect(strings, 'the name never reached the file at all').toContain('QA');

    const sheet = entry(zip, 'xl/worksheets/sheet1.xml') ?? '';
    expect(sheet, 'a formula element was written — Excel would evaluate it').not.toMatch(/<f[ >]/);

    await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]).catch(() => undefined);
  });
});
