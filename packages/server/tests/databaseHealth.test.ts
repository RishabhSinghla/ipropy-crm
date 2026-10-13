import { describe, expect, it } from 'vitest';
import { makeDatabaseHealth, REMEMBER_BAD_MS, REMEMBER_GOOD_MS } from '../src/core/databaseHealth.js';

function setup(answers: boolean[]) {
  let clock = 0;
  let asked = 0;
  const check = makeDatabaseHealth(async () => answers[Math.min(asked++, answers.length - 1)]!, () => clock);
  return { check, advance: (ms: number) => { clock += ms; }, asked: () => asked };
}

describe('the health check and the database', () => {
  it('asks the database the first time', async () => {
    const t = setup([true]);
    expect(await t.check()).toBe(true);
    expect(t.asked()).toBe(1);
  });

  it('does not ask again while the good answer is recent — this is what lets Neon sleep', async () => {
    const t = setup([true]);
    await t.check();
    for (let i = 0; i < 100; i += 1) { t.advance(5_000); await t.check(); }
    expect(t.asked()).toBe(1);
  });

  it('asks again once the good answer is ten minutes old', async () => {
    const t = setup([true]);
    await t.check();
    t.advance(REMEMBER_GOOD_MS);
    await t.check();
    expect(t.asked()).toBe(2);
  });

  it('remembers a failure only briefly, so recovery is noticed quickly', async () => {
    const t = setup([false, true]);
    expect(await t.check()).toBe(false);
    t.advance(REMEMBER_BAD_MS);
    expect(await t.check()).toBe(true);
    expect(t.asked()).toBe(2);
  });

  it('asks every time when somebody wants a fresh answer', async () => {
    const t = setup([true]);
    await t.check();
    await t.check(true);
    expect(t.asked()).toBe(2);
  });
});
