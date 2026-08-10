/**
 * Razorpay — the only place that speaks to the payment gateway.
 *
 * Optional in exactly the way the AI providers are: with no keys configured
 * every call refuses politely and the rest of the control plane keeps working,
 * so a developer without a merchant account can still run, test and provision.
 * `isConfigured()` is what callers check before offering to charge anybody.
 *
 * Two things here are security-critical rather than merely important:
 *
 * - **Signature verification uses the raw request body.** Re-serialising parsed
 *   JSON changes key order and whitespace, so the HMAC stops matching and the
 *   temptation becomes to skip the check. The webhook route hands us a Buffer.
 * - **The comparison is timing-safe.** A byte-by-byte `===` on a signature is
 *   the textbook remote timing oracle.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Plan } from './plans.js';

const API = 'https://api.razorpay.com/v1';

export type FetchLike = typeof globalThis.fetch;

export function isConfigured(): boolean {
  return Boolean(config.billing.keyId && config.billing.keySecret);
}

function authHeader(): string {
  const pair = `${config.billing.keyId}:${config.billing.keySecret}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<T> {
  if (!isConfigured()) {
    throw new Error('Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  }

  const res = await fetchImpl(`${API}${path}`, {
    method: init.method,
    headers: {
      authorization: authHeader(),
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  if (!res.ok) {
    // Razorpay puts the useful sentence in error.description; the status alone
    // says nothing an operator can act on.
    let description = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { description?: string } };
      if (parsed.error?.description) description = parsed.error.description;
    } catch { /* keep the raw body */ }
    throw new Error(`Razorpay ${init.method} ${path} failed (${res.status}): ${description}`);
  }

  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Plans and subscriptions
// ---------------------------------------------------------------------------

export interface RazorpayPlan { id: string }
export interface RazorpaySubscription {
  id: string;
  status: string;
  /** Where the customer authorises the mandate. Sent to them; not stored. */
  short_url?: string;
  current_end?: number;
}

/**
 * Create the gateway-side plan for one of ours.
 *
 * Called once per plan, not once per customer: Razorpay plans are templates and
 * a customer's subscription points at one. The returned id belongs in
 * RAZORPAY_PLAN_IDS so restarting does not create duplicates.
 */
export async function createPlan(plan: Plan, fetchImpl?: FetchLike): Promise<RazorpayPlan> {
  return call<RazorpayPlan>('/plans', {
    method: 'POST',
    body: {
      period: 'monthly',
      interval: 1,
      item: {
        name: `iPropy ${plan.label}`,
        amount: plan.amountPaise,
        currency: 'INR',
        description: plan.blurb,
      },
    },
  }, fetchImpl);
}

/**
 * `totalCount` is how many billing cycles Razorpay will attempt. Twelve rather
 * than "forever" because a mandate that renews indefinitely with no review is
 * how customers end up disputing charges a year after they stopped using it.
 */
export async function createSubscription(opts: {
  razorpayPlanId: string;
  notifyEmail: string;
  totalCount?: number;
  notes?: Record<string, string>;
  fetchImpl?: FetchLike;
}): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>('/subscriptions', {
    method: 'POST',
    body: {
      plan_id: opts.razorpayPlanId,
      total_count: opts.totalCount ?? 12,
      customer_notify: 1,
      notes: opts.notes ?? {},
    },
  }, opts.fetchImpl);
}

export async function fetchSubscription(id: string, fetchImpl?: FetchLike): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>(`/subscriptions/${id}`, { method: 'GET' }, fetchImpl);
}

export async function cancelSubscription(id: string, atCycleEnd = true, fetchImpl?: FetchLike): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>(`/subscriptions/${id}/cancel`, {
    method: 'POST',
    body: { cancel_at_cycle_end: atCycleEnd ? 1 : 0 },
  }, fetchImpl);
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Is this delivery really from Razorpay?
 *
 * Everything downstream — activating a customer, suspending one — trusts the
 * answer, so it fails closed: no secret configured means no webhook is
 * accepted. The alternative, accepting unsigned deliveries when unconfigured,
 * is a public endpoint that suspends any customer whose slug you can guess.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = config.billing.webhookSecret;
  if (!secret) {
    logger.warn('a Razorpay webhook arrived but RAZORPAY_WEBHOOK_SECRET is unset; rejecting it');
    return false;
  }
  if (!signature) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a leak-free
  // early exit — the lengths are fixed and public.
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, provided);
}

export interface WebhookEvent {
  event: string;
  payload?: {
    subscription?: { entity?: { id?: string; status?: string; current_end?: number; notes?: Record<string, string> } };
    payment?: { entity?: { id?: string; amount?: number; status?: string } };
  };
}
