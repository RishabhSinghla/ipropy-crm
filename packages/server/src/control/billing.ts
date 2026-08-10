/**
 * What a payment event means for a customer's service.
 *
 * The mapping from gateway event to "can these people still log in" is the part
 * worth reading. It is deliberately generous in one direction and strict in the
 * other: paying reinstates a customer immediately, while failing to pay costs
 * them nothing until the grace period runs out. A CRM that locks a builder out
 * of their own leads the hour a card expires is a CRM they leave.
 *
 * Nothing here cancels a subscription or moves money. Suspension only sets a
 * status; the data stays exactly where it was.
 */
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { resolvePlan } from './plans.js';
import { openControlPool } from './store.js';
import * as store from './store.js';
import type { WebhookEvent } from './razorpay.js';

export type SubscriptionStatus =
  | 'trialing'      // no card yet
  | 'active'        // paid, current
  | 'past_due'      // a charge failed; still serving, inside the grace period
  | 'cancelled'     // they left, or the mandate was revoked
  | 'invoiced';     // paying us outside the gateway — never touched by webhooks

export interface Subscription {
  tenantId: string;
  planKey: string;
  razorpaySubscriptionId: string | null;
  status: SubscriptionStatus;
  servesUntil: string | null;
  lastPaymentAt: string | null;
}

interface Row {
  tenant_id: string; plan_key: string; razorpay_subscription_id: string | null;
  status: SubscriptionStatus; serves_until: string | Date | null; last_payment_at: string | Date | null;
}

/** pg returns a Date for timestamptz; `Subscription` promises an ISO string. */
function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

const toSubscription = (row: Row): Subscription => ({
  tenantId: row.tenant_id,
  planKey: row.plan_key,
  razorpaySubscriptionId: row.razorpay_subscription_id,
  status: row.status,
  servesUntil: iso(row.serves_until),
  lastPaymentAt: iso(row.last_payment_at),
});

export async function getSubscription(tenantId: string): Promise<Subscription | null> {
  const db = await openControlPool();
  const res = await db.query<Row>(`SELECT * FROM ctl_subscription WHERE tenant_id = $1`, [tenantId]);
  return res.rows[0] ? toSubscription(res.rows[0]) : null;
}

/** Idempotent: re-running with the same plan leaves everything as it was. */
export async function startTrial(tenantId: string, planKey: string, days = 30): Promise<Subscription> {
  const db = await openControlPool();
  const res = await db.query<Row>(
    `INSERT INTO ctl_subscription (tenant_id, plan_key, status, serves_until)
     VALUES ($1, $2, 'trialing', now() + make_interval(days => $3))
     ON CONFLICT (tenant_id) DO UPDATE SET plan_key = EXCLUDED.plan_key, updated_at = now()
     RETURNING *`,
    [tenantId, planKey, days],
  );
  return toSubscription(res.rows[0]);
}

export async function attachRazorpaySubscription(
  tenantId: string, planKey: string, razorpaySubscriptionId: string,
): Promise<void> {
  const db = await openControlPool();
  await db.query(
    `INSERT INTO ctl_subscription (tenant_id, plan_key, razorpay_subscription_id, status)
     VALUES ($1, $2, $3, 'trialing')
     ON CONFLICT (tenant_id) DO UPDATE
       SET plan_key = EXCLUDED.plan_key,
           razorpay_subscription_id = EXCLUDED.razorpay_subscription_id,
           updated_at = now()`,
    [tenantId, planKey, razorpaySubscriptionId],
  );
}

/** Mark a customer as paying us outside the gateway — a cheque, an invoice, a favour. */
export async function markInvoiced(tenantId: string, planKey: string, servesUntil: Date): Promise<void> {
  const db = await openControlPool();
  await db.query(
    `INSERT INTO ctl_subscription (tenant_id, plan_key, status, serves_until)
     VALUES ($1, $2, 'invoiced', $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET plan_key = EXCLUDED.plan_key, status = 'invoiced',
           serves_until = EXCLUDED.serves_until, updated_at = now()`,
    [tenantId, planKey, servesUntil.toISOString()],
  );
}

// ---------------------------------------------------------------------------
// Webhook handling
// ---------------------------------------------------------------------------

/**
 * The decision table.
 *
 * Exported and pure so it can be tested without a database or a gateway, which
 * matters more here than anywhere else in the control plane: this is the code
 * that decides whether a paying customer can work tomorrow morning, and it will
 * run for the first time against real money.
 */
export interface BillingDecision {
  subscriptionStatus: SubscriptionStatus | null;
  /** null = leave the tenant's status alone. */
  tenantStatus: 'active' | 'suspended' | null;
  /** Days from now that service is guaranteed until, when the event implies one. */
  servesForDays: number | null;
  recordPayment: boolean;
  note: string;
}

export function decide(event: string, planKey: string): BillingDecision {
  const plan = resolvePlan(planKey);

  switch (event) {
    // The mandate is authorised. Nothing has been charged yet on some flows, but
    // the customer has done their part and should be able to work.
    case 'subscription.authenticated':
    case 'subscription.activated':
      return {
        subscriptionStatus: 'active', tenantStatus: 'active',
        servesForDays: 31, recordPayment: false,
        note: 'mandate authorised',
      };

    // Money arrived. This is the only event that extends the period.
    case 'subscription.charged':
      return {
        subscriptionStatus: 'active', tenantStatus: 'active',
        servesForDays: 31, recordPayment: true,
        note: 'payment received',
      };

    // A charge failed and Razorpay will retry. The customer keeps working for
    // the grace period — suspending on the first failure punishes an expired
    // card the same as a refusal to pay.
    case 'subscription.pending':
    case 'payment.failed':
      return {
        subscriptionStatus: 'past_due', tenantStatus: null,
        servesForDays: plan.graceDays, recordPayment: false,
        note: `payment failed; ${plan.graceDays} days of grace`,
      };

    // Razorpay gave up retrying, or the customer cancelled. Service stops, data
    // stays: `suspended` is reversible and touches nothing.
    case 'subscription.halted':
      return {
        subscriptionStatus: 'past_due', tenantStatus: 'suspended',
        servesForDays: 0, recordPayment: false,
        note: 'gateway stopped retrying',
      };

    case 'subscription.cancelled':
    case 'subscription.completed':
      return {
        subscriptionStatus: 'cancelled', tenantStatus: 'suspended',
        servesForDays: 0, recordPayment: false,
        note: event === 'subscription.completed' ? 'subscription ran to its end' : 'cancelled',
      };

    // Everything else Razorpay sends — refunds, settlements, order events. Worth
    // recording that it arrived, never worth acting on blindly.
    default:
      return {
        subscriptionStatus: null, tenantStatus: null,
        servesForDays: null, recordPayment: false,
        note: `ignored (${event})`,
      };
  }
}

/**
 * Has this delivery been seen before?
 *
 * Razorpay retries until it gets a 2xx, so duplicates are normal rather than
 * exceptional. The insert is the lock: two concurrent deliveries race, one wins
 * the unique constraint, the loser is told it is a duplicate.
 */
export async function claimEvent(db: Pool, provider: string, externalId: string, kind: string): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO ctl_webhook_event (provider, external_id, kind)
     VALUES ($1,$2,$3)
     ON CONFLICT (provider, external_id) DO NOTHING
     RETURNING id`,
    [provider, externalId, kind],
  );
  return res.rowCount === 1;
}

export interface HandledWebhook {
  handled: boolean;
  duplicate: boolean;
  note: string;
}

export async function handleRazorpayEvent(body: WebhookEvent, eventId: string): Promise<HandledWebhook> {
  const db = await openControlPool();
  const subscriptionId = body.payload?.subscription?.entity?.id;
  const kind = body.event;

  if (!await claimEvent(db, 'razorpay', eventId, kind)) {
    return { handled: false, duplicate: true, note: 'already processed' };
  }

  if (!subscriptionId) {
    // Payment events unrelated to a subscription, and everything else.
    return { handled: false, duplicate: false, note: `no subscription in ${kind}` };
  }

  const found = await db.query<Row & { slug: string; tenant_id: string }>(
    `SELECT s.*, t.slug FROM ctl_subscription s
       JOIN ctl_tenant t ON t.id = s.tenant_id
      WHERE s.razorpay_subscription_id = $1`,
    [subscriptionId],
  );
  const row = found.rows[0];
  if (!row) {
    // A live subscription we have no record of is worth a loud log and a 200:
    // returning an error only makes Razorpay retry something we cannot fix.
    logger.warn({ subscriptionId, kind }, 'webhook for a subscription this control plane does not know');
    return { handled: false, duplicate: false, note: 'unknown subscription' };
  }

  const decision = decide(kind, row.plan_key);
  if (!decision.subscriptionStatus && decision.tenantStatus === null) {
    return { handled: false, duplicate: false, note: decision.note };
  }

  await db.query(
    `UPDATE ctl_subscription
        SET status = COALESCE($2, status),
            serves_until = CASE WHEN $3::int IS NULL THEN serves_until
                                ELSE now() + make_interval(days => $3::int) END,
            last_payment_at = CASE WHEN $4 THEN now() ELSE last_payment_at END,
            updated_at = now()
      WHERE tenant_id = $1`,
    [row.tenant_id, decision.subscriptionStatus, decision.servesForDays, decision.recordPayment],
  );

  if (decision.tenantStatus) {
    await store.setStatus(row.tenant_id, decision.tenantStatus);
  }
  await store.recordEvent(row.tenant_id, `billing:${kind}`, decision.note);

  logger.info({ slug: row.slug, kind, note: decision.note }, 'billing event applied');
  return { handled: true, duplicate: false, note: decision.note };
}

/**
 * Suspend everyone whose paid-for time has run out.
 *
 * The webhook suspends on `halted`, which is the gateway's decision and arrives
 * late — Razorpay retries a failed charge for days first. This is the clock
 * running out on our side, and it is what actually enforces the grace period.
 * Run it daily.
 */
export async function suspendLapsed(now = new Date()): Promise<string[]> {
  const db = await openControlPool();
  const res = await db.query<{ tenant_id: string; slug: string }>(
    `SELECT s.tenant_id, t.slug
       FROM ctl_subscription s
       JOIN ctl_tenant t ON t.id = s.tenant_id
      WHERE t.status = 'active'
        AND s.status <> 'invoiced'
        AND s.serves_until IS NOT NULL
        AND s.serves_until < $1`,
    [now.toISOString()],
  );

  for (const row of res.rows) {
    await store.setStatus(row.tenant_id, 'suspended');
    await store.recordEvent(row.tenant_id, 'billing:lapsed', 'paid period ended');
    logger.info({ slug: row.slug }, 'suspended: paid period ended');
  }
  return res.rows.map((r) => r.slug);
}
