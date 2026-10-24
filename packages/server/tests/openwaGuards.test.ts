import { describe, expect, it } from 'vitest';
import { decideSend, DEFAULT_LIMITS, takeSendSlot } from '../src/integrations/whatsapp/business/openwaGuards.js';

const limits = { perUserDaily: 3, perNumberDaily: 2, minSpacingSeconds: 10 };
const quiet = { userToday: 0, numberToday: 0, secondsSinceLast: null };

describe('the send brakes', () => {
  it('lets a first message through', () => {
    expect(decideSend(limits, quiet)).toEqual({ ok: true });
  });
  it('makes a second send wait out the minimum spacing', () => {
    const verdict = decideSend(limits, { ...quiet, secondsSinceLast: 4 });
    expect(verdict).toMatchObject({ ok: false, code: 'TOO_SOON', retryAfterSeconds: 6 });
    expect(decideSend(limits, { ...quiet, secondsSinceLast: 10 })).toEqual({ ok: true });
  });
  it('stops a user at their daily cap, in plain words', () => {
    const verdict = decideSend(limits, { ...quiet, userToday: 3 });
    expect(verdict).toMatchObject({ ok: false, code: 'USER_DAILY_CAP' });
    expect((verdict as { message: string }).message).toMatch(/limit of 3/);
  });
  it('stops messages to one customer at the per-number cap even when the user has room', () => {
    expect(decideSend(limits, { ...quiet, numberToday: 2 })).toMatchObject({ ok: false, code: 'NUMBER_DAILY_CAP' });
  });
  it('checks spacing before the caps so the wait is the first thing a rep hears', () => {
    expect(decideSend(limits, { userToday: 99, numberToday: 99, secondsSinceLast: 1 })).toMatchObject({ code: 'TOO_SOON' });
  });
  it('ships conservative defaults', () => {
    expect(DEFAULT_LIMITS.perUserDaily).toBeLessThanOrEqual(100);
    expect(DEFAULT_LIMITS.perNumberDaily).toBeLessThanOrEqual(20);
    expect(DEFAULT_LIMITS.minSpacingSeconds).toBeGreaterThanOrEqual(5);
  });
});

describe('the one send slot', () => {
  it('lets only one send decide at a time, in order', async () => {
    const order: string[] = [];
    const run = async (name: string, ms: number): Promise<void> => {
      const release = await takeSendSlot();
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      release();
    };
    await Promise.all([run('a', 30), run('b', 5), run('c', 1)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });
  it('is released when the holder gives it up, so a refusal never blocks the next send', async () => {
    const first = await takeSendSlot();
    first();
    const second = await Promise.race([takeSendSlot(), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
    expect(second).not.toBeNull();
    (second as () => void)();
  });
});
