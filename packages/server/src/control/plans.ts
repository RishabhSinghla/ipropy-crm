/**
 * What a customer can buy.
 *
 * Prices are in paise because that is what Razorpay bills in, and rounding
 * rupees into paise at the call site is how a plan ends up costing a hundredth
 * of what it should. `priceInr` exists only for printing.
 *
 * Kept in code rather than in the database on purpose: a price change should be
 * a reviewed commit with a date on it, not a row somebody edited. Existing
 * subscriptions keep the Razorpay plan id they were created with, so changing a
 * price here never silently re-prices a customer who already signed.
 */
export interface Plan {
  key: string;
  label: string;
  /** Monthly price in paise. 0 means it never goes to Razorpay. */
  amountPaise: number;
  /** What the sales page says. */
  blurb: string;
  /** Seats included; not enforced yet, recorded so enforcement has a number to read. */
  seats: number;
  /** Days a customer keeps working after a failed payment before suspension. */
  graceDays: number;
}

export const PLANS: Record<string, Plan> = {
  trial: {
    key: 'trial',
    label: 'Trial',
    amountPaise: 0,
    blurb: 'Thirty days, the whole product, no card.',
    seats: 5,
    graceDays: 0,
  },
  starter: {
    key: 'starter',
    label: 'Starter',
    amountPaise: 249_900, // ₹2,499
    blurb: 'Up to 10 users. Everything except the API.',
    seats: 10,
    graceDays: 7,
  },
  growth: {
    key: 'growth',
    label: 'Growth',
    amountPaise: 599_900, // ₹5,999
    blurb: 'Up to 30 users, API access, priority support.',
    seats: 30,
    graceDays: 7,
  },
};

export const DEFAULT_PLAN = 'trial';

export function resolvePlan(key: string): Plan {
  const plan = PLANS[key];
  if (!plan) {
    throw new Error(`Unknown plan "${key}". Available: ${Object.keys(PLANS).join(', ')}.`);
  }
  return plan;
}

/** ₹2,499 — for invoices, emails and the CLI, never for arithmetic. */
export function formatPrice(plan: Plan): string {
  if (!plan.amountPaise) return 'free';
  return `₹${(plan.amountPaise / 100).toLocaleString('en-IN')}`;
}

/**
 * `RAZORPAY_PLAN_IDS` maps our plan keys to the gateway's, e.g.
 * `starter=plan_ABC123,growth=plan_DEF456`.
 *
 * An environment variable rather than a table because these ids are created
 * once and never change: putting them in the database would invite editing
 * them, and an edited plan id re-prices every subscription created afterwards.
 */
export function parsePlanIds(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [key, id] = pair.split('=').map((s) => s.trim());
    if (key && id) map[key] = id;
  }
  return map;
}
