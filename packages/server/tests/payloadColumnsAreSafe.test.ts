/**
 * The column name goes into the SQL, so it has to be a real column.
 *
 * `fieldText`/`fieldJson` write the name directly rather than binding it —
 * that is the whole point, since a bound parameter cannot be a column
 * reference — and the safety is that the name is checked against the set that
 * came from `information_schema` first. Anything not in that set becomes NULL
 * and never reaches the statement.
 *
 * Worth a test rather than a comment: the guard is one `has()` call, and the
 * day somebody "simplifies" it away nothing else would notice.
 */
import { describe, expect, it } from 'vitest';
import { fieldText, fieldJson } from '../src/core/entity/payloadColumns.js';

const real = new Set(['mobile', 'status', 'custom_fields']);

describe('reading a payload column', () => {
  it('writes the name only when the database actually has it', () => {
    expect(fieldText(real, 'l', 'mobile')).toBe(`to_jsonb(l."mobile")#>>'{}'`);
    expect(fieldJson(real, 'l', 'status')).toBe(`to_jsonb(l."status")`);
  });

  it('answers NULL for a field an admin has deleted', () => {
    expect(fieldText(real, 'l', 'whatsapp_number')).toBe('NULL::text');
    expect(fieldJson(real, 'l', 'whatsapp_number')).toBe(`'null'::jsonb`);
  });

  it('lets nothing through that is not a column, however it is spelled', () => {
    const attempts = [
      `mobile"; DROP TABLE ipy_record; --`,
      `mobile') OR '1'='1`,
      'mobile, (SELECT password_hash FROM ipy_user LIMIT 1)',
      '"',
      '*',
      '',
    ];
    for (const attempt of attempts) {
      // None of these is in `real`, so none of them is ever written.
      expect(fieldText(real, 'l', attempt), attempt).toBe('NULL::text');
      expect(fieldJson(real, 'l', attempt), attempt).toBe(`'null'::jsonb`);
    }
  });

  it('is still safe when the set itself is empty', () => {
    expect(fieldText(new Set(), 'l', 'mobile')).toBe('NULL::text');
  });
});
