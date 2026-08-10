/**
 * Billing, minus the database and the gateway.
 *
 * `decide` is pure precisely so this file can exist: it is the code that
 * determines whether a builder can open their leads tomorrow morning, and it
 * will run for the first time against real money and a real customer. Every
 * event Razorpay is documented to send has a case here, including the ones we
 * deliberately ignore.
 */
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decide, startLapseSweep } from '../../src/control/billing.js';
import { formatPrice, parsePlanIds, PLANS, resolvePlan } from '../../src/control/plans.js';
import { verifyWebhookSignature } from '../../src/control/razorpay.js';
import { config } from '../../src/config.js';

describe('decide', () => {
  it('lets a customer in as soon as the mandate is authorised, before any money moves', () => {
    // Razorpay authenticates the mandate first and charges after. Waiting for
    // the charge would lock out a customer who has done everything asked.
    const d = decide('subscription.authenticated', 'starter');
    expect(d.tenantStatus).toBe('active');
    expect(d.recordPayment).toBe(false);
  });

  it('extends service and records the payment only when money actually arrives', () => {
    const charged = decide('subscription.charged', 'starter');
    expect(charged).toMatchObject({ subscriptionStatus: 'active', tenantStatus: 'active', recordPayment: true });
    expect(charged.servesForDays).toBe(31);

    // Every other event that keeps them active must not claim a payment.
    expect(decide('subscription.activated', 'starter').recordPayment).toBe(false);
  });

  it('does not suspend on the first failed charge — it grants the plan\'s grace', () => {
    const d = decide('payment.failed', 'starter');
    expect(d.tenantStatus).toBeNull();
    expect(d.subscriptionStatus).toBe('past_due');
    expect(d.servesForDays).toBe(PLANS.starter.graceDays);
  });

  it('suspends when the gateway itself gives up', () => {
    expect(decide('subscription.halted', 'starter')).toMatchObject({
      tenantStatus: 'suspended', servesForDays: 0,
    });
  });

  it.each(['subscription.cancelled', 'subscription.completed'])('ends service on %s', (event) => {
    expect(decide(event, 'growth')).toMatchObject({
      subscriptionStatus: 'cancelled', tenantStatus: 'suspended', servesForDays: 0,
    });
  });

  it.each([
    'payment.captured', 'refund.created', 'order.paid', 'settlement.processed', 'nonsense.event',
  ])('ignores %s rather than guessing', (event) => {
    expect(decide(event, 'starter')).toMatchObject({
      subscriptionStatus: null, tenantStatus: null, recordPayment: false,
    });
  });

  it('never grants grace on a plan that has none', () => {
    expect(decide('payment.failed', 'trial').servesForDays).toBe(0);
  });

  it('refuses an unknown plan instead of defaulting to one', () => {
    expect(() => decide('subscription.charged', 'enterprise')).toThrow(/Unknown plan/);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test_secret';
  const body = Buffer.from(JSON.stringify({ event: 'subscription.charged' }));
  const sign = (buf: Buffer, key = secret): string =>
    crypto.createHmac('sha256', key).update(buf).digest('hex');

  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const withSecret = (value: string): void => {
    vi.spyOn(config.billing, 'webhookSecret', 'get').mockReturnValue(value);
  };

  it('accepts a correctly signed body', () => {
    withSecret(secret);
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it('rejects a body signed with the wrong secret', () => {
    withSecret(secret);
    expect(verifyWebhookSignature(body, sign(body, 'whsec_attacker'))).toBe(false);
  });

  it('rejects a tampered body', () => {
    withSecret(secret);
    const signature = sign(body);
    const tampered = Buffer.from(JSON.stringify({ event: 'subscription.cancelled' }));
    expect(verifyWebhookSignature(tampered, signature)).toBe(false);
  });

  it('rejects a missing signature', () => {
    withSecret(secret);
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the length check has to come
    // first or a short signature is a 500 instead of a 401.
    withSecret(secret);
    expect(() => verifyWebhookSignature(body, 'abc')).not.toThrow();
    expect(verifyWebhookSignature(body, 'abc')).toBe(false);
  });

  it('fails closed when no secret is configured', () => {
    // The alternative — accepting unsigned deliveries when unconfigured — is a
    // public endpoint that can suspend any customer.
    withSecret('');
    expect(verifyWebhookSignature(body, sign(body))).toBe(false);
  });
});

describe('plans', () => {
  it('prices in paise, prints in rupees', () => {
    expect(PLANS.starter.amountPaise).toBe(249_900);
    expect(formatPrice(PLANS.starter)).toBe('₹2,499');
    expect(formatPrice(PLANS.trial)).toBe('free');
  });

  it('parses the plan id map', () => {
    expect(parsePlanIds('starter=plan_ABC, growth=plan_DEF')).toEqual({
      starter: 'plan_ABC', growth: 'plan_DEF',
    });
  });

  it('ignores malformed pairs rather than mapping a plan to nothing', () => {
    expect(parsePlanIds('starter=plan_ABC,broken,=x,y=')).toEqual({ starter: 'plan_ABC' });
  });

  it('resolves a known plan and refuses an unknown one', () => {
    expect(resolvePlan('growth').label).toBe('Growth');
    expect(() => resolvePlan('platinum')).toThrow(/Unknown plan/);
  });
});

describe('startLapseSweep', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits before its first run, so a restart loop cannot hammer the database', () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue([]);
    const sweep = startLapseSweep({ firstRunMs: 60_000, task });

    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_000);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(task).toHaveBeenCalledTimes(1);

    sweep.stop();
  });

  it('keeps running on the interval, and stops when told', () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue([]);
    const sweep = startLapseSweep({ everyHours: 6, firstRunMs: 1, task });

    vi.advanceTimersByTime(1 + 6 * 3_600_000 * 2);
    expect(task).toHaveBeenCalledTimes(3); // the first run plus two intervals

    sweep.stop();
    vi.advanceTimersByTime(6 * 3_600_000 * 5);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('survives a failing sweep rather than taking the process down', () => {
    // An unhandled rejection in a timer callback would kill the control plane,
    // and a transient database blip must not stop customers being served.
    vi.useFakeTimers();
    const task = vi.fn().mockRejectedValue(new Error('database went away'));
    const sweep = startLapseSweep({ firstRunMs: 1, task });

    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    sweep.stop();
  });
});
