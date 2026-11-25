/** The slow drip's rules, without a database: how slow, when, who is skipped, what the words are, and when it stops itself. */
import { describe, expect, it } from 'vitest';
import {
  capForDay, chooseDripNumber, clampSpeed, composeMessage, DEFAULT_VARIANTS, fillVariant, gapSeconds,
  HARD_MAX_PER_NUMBER_PER_DAY, indianMobileKey, inWindow, MIN_GAP_SECONDS, OPT_OUT_LINE, pauseCause, usableFirstName,
  variantIndex, variantsProblem, withOptOut, type NumberState,
} from '../src/integrations/whatsapp/business/dripRules.js';
import { consentKeyword } from '../src/core/consent/index.js';

const num = (over: Partial<NumberState> = {}): NumberState => ({
  id: 'a', label: 'Shikha', status: 'ready', paused: false, sentToday: 0, lastSentAtMs: null, restricted: false, ...over,
});

describe('the speed limits cannot be switched off', () => {
  it('starts at 20 a day and ramps slowly', () => {
    const s = clampSpeed();
    expect(capForDay(0, s)).toBe(20);
    expect(capForDay(2, s)).toBe(20);
    expect(capForDay(3, s)).toBe(25);
    expect(capForDay(6, s)).toBe(30);
  });
  it('never goes above the hard ceiling, however it is typed', () => {
    const s = clampSpeed({ capStart: 500, capMax: 9999, capStep: 999 });
    expect(s.capMax).toBe(HARD_MAX_PER_NUMBER_PER_DAY);
    expect(capForDay(0, s)).toBeLessThanOrEqual(HARD_MAX_PER_NUMBER_PER_DAY);
    expect(capForDay(500, s)).toBe(HARD_MAX_PER_NUMBER_PER_DAY);
    expect(HARD_MAX_PER_NUMBER_PER_DAY).toBeLessThan(60); // the per-user cap for hand-typed messages
  });
  it('never allows a gap under a minute', () => {
    const s = clampSpeed({ gapMinSeconds: 1, gapMaxSeconds: 2 });
    expect(s.gapMinSeconds).toBe(MIN_GAP_SECONDS);
    for (let i = 0; i < 200; i += 1) expect(gapSeconds(s)).toBeGreaterThanOrEqual(MIN_GAP_SECONDS);
  });
  it('the gap is random between the two ends and not an even beat', () => {
    const s = clampSpeed();
    expect(gapSeconds(s, () => 0)).toBe(60);
    expect(gapSeconds(s, () => 1)).toBe(120);
    expect(new Set(Array.from({ length: 50 }, () => gapSeconds(s))).size).toBeGreaterThan(5);
  });
  it('keeps a daytime window that ends by 9 pm and is at least two hours', () => {
    const s = clampSpeed({ windowFrom: 3, windowTo: 23 });
    expect(s.windowFrom).toBeGreaterThanOrEqual(6);
    expect(s.windowTo).toBeLessThanOrEqual(21);
    expect(clampSpeed({ windowFrom: 10, windowTo: 10 }).windowTo).toBeGreaterThanOrEqual(12);
  });
  it('sends only inside the window', () => {
    const s = clampSpeed();
    expect(inWindow(9, s)).toBe(false);
    expect(inWindow(10, s)).toBe(true);
    expect(inWindow(17, s)).toBe(true);
    expect(inWindow(18, s)).toBe(false);
    expect(inWindow(23, s)).toBe(false);
  });
});

describe('who is skipped', () => {
  it('accepts Indian mobiles however they are written, and nothing else', () => {
    expect(indianMobileKey('9811533633')).toBe('9811533633');
    expect(indianMobileKey('+91 98115 33633')).toBe('9811533633');
    expect(indianMobileKey('919811533633')).toBe('9811533633');
    expect(indianMobileKey('09811533633')).toBe('9811533633');
    expect(indianMobileKey('1234567890')).toBeNull(); // does not start 6-9
    expect(indianMobileKey('98115')).toBeNull();
    expect(indianMobileKey('')).toBeNull();
    expect(indianMobileKey(null)).toBeNull();
    expect(indianMobileKey('+44 7911 123456')).toBeNull();
  });
});

describe('the words', () => {
  it('every message ends with the opt-out line, once', () => {
    expect(withOptOut('Hello there from IPROPY')).toMatch(/Reply STOP to stop$/);
    const twice = withOptOut(withOptOut('Hello there from IPROPY'));
    expect(twice.match(/Reply STOP to stop/g)).toHaveLength(1);
    for (const v of DEFAULT_VARIANTS) expect(composeMessage([v], 'r1', 'Ravi').text.endsWith(OPT_OUT_LINE)).toBe(true);
  });
  it('uses the first name when it is a real name, and drops the gap cleanly when it is not', () => {
    expect(fillVariant('Hello {name}, welcome', 'Ravi')).toBe('Hello Ravi, welcome');
    expect(fillVariant('Hello {name}, welcome', null)).toBe('Hello, welcome');
    expect(usableFirstName('ravi kumar')).toBe('Ravi');
    expect(usableFirstName('  SHIKHA ')).toBe('Shikha');
    expect(usableFirstName('Mr Sharma')).toBeNull();
    expect(usableFirstName('9811533633')).toBeNull();
    expect(usableFirstName('2BHK buyer')).toBeNull();
    expect(usableFirstName('')).toBeNull();
    expect(usableFirstName(undefined)).toBeNull();
  });
  it('different people get different wordings, and the same person always the same', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `record-${i}-abcdef`);
    const used = new Set(ids.map((id) => variantIndex(id, DEFAULT_VARIANTS.length)));
    expect(used.size).toBeGreaterThan(1);
    expect(variantIndex('record-7-abcdef', 4)).toBe(variantIndex('record-7-abcdef', 4));
    expect(variantIndex('x', 1)).toBe(0);
  });
  it('the default wordings are all different and carry the owner\'s message', () => {
    expect(variantsProblem(DEFAULT_VARIANTS)).toBeNull();
    for (const v of DEFAULT_VARIANTS) {
      expect(v).toContain('IPROPY | Your Own Property Advisor');
      expect(v).toContain('9811533633');
      expect(v).toContain('Yogesh Bindal');
      expect(v).toContain('A-1875 Mall Road');
    }
  });
  it('refuses unusable wordings: none, too many, duplicates, links, too short', () => {
    expect(variantsProblem([])).not.toBeNull();
    expect(variantsProblem(['short'])).not.toBeNull();
    const a = 'Hello from IPROPY, a long enough message to use.';
    expect(variantsProblem([a, a.toUpperCase()])).not.toBeNull();
    expect(variantsProblem([`${a} See https://example.com`])).not.toBeNull();
    expect(variantsProblem(Array.from({ length: 7 }, (_, i) => `${a} ${i}`))).not.toBeNull();
    expect(variantsProblem([a])).toBeNull();
  });
  it('a customer replying STOP is read as an opt-out by the inbound path the queue relies on', () => {
    for (const reply of ['STOP', 'stop', 'Stop.', ' stop ', 'Unsubscribe']) expect(consentKeyword(reply)).toBe('opt_out');
    expect(consentKeyword("don't stop calling me about the flat")).toBeNull();
  });
});

describe('which number goes next', () => {
  it('takes turns: the one that sent least recently', () => {
    const numbers = [num({ id: 'a', lastSentAtMs: 300 }), num({ id: 'b', lastSentAtMs: 100 }), num({ id: 'c', lastSentAtMs: 200 })];
    expect(chooseDripNumber(numbers, 20)?.id).toBe('b');
  });
  it('a number that has never sent goes before one that has', () => {
    expect(chooseDripNumber([num({ id: 'a', lastSentAtMs: 5 }), num({ id: 'b' })], 20)?.id).toBe('b');
  });
  it('leaves out numbers that are not ready, paused, restricted or at today\'s cap', () => {
    const numbers = [
      num({ id: 'down', status: 'disconnected' }), num({ id: 'paused', paused: true }), num({ id: 'limited', restricted: true }),
      num({ id: 'full', sentToday: 20 }), num({ id: 'ok', sentToday: 19 }),
    ];
    expect(chooseDripNumber(numbers, 20)?.id).toBe('ok');
    expect(chooseDripNumber(numbers.filter((n) => n.id !== 'ok'), 20)).toBeNull();
  });
});

describe('when the queue stops itself', () => {
  it('stays running when all is well', () => {
    expect(pauseCause({ numbers: [num(), num({ id: 'b' })], failuresLastDay: 2 })).toBeNull();
  });
  it('pauses when a number drops, naming it', () => {
    const c = pauseCause({ numbers: [num(), num({ id: 'b', label: 'Deepak', status: 'disconnected' })], failuresLastDay: 0 });
    expect(c?.why).toBe('number_down');
    expect(c?.message).toContain('Deepak');
  });
  it('pauses when WhatsApp reports a restriction', () => {
    expect(pauseCause({ numbers: [num({ restricted: true })], failuresLastDay: 0 })?.why).toBe('restricted');
  });
  it('pauses on the third failure in a day', () => {
    expect(pauseCause({ numbers: [num()], failuresLastDay: 3 })?.why).toBe('failures');
  });
  it('a number an admin paused on purpose is left out, not an alarm; but all paused is', () => {
    expect(pauseCause({ numbers: [num(), num({ id: 'b', paused: true, status: 'disconnected' })], failuresLastDay: 0 })).toBeNull();
    expect(pauseCause({ numbers: [num({ paused: true })], failuresLastDay: 0 })?.why).toBe('number_down');
  });
});
