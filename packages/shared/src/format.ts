import { CRORE, LAKH } from './constants.js';

/**
 * Formatting helpers shared by the server (for AI prompts, emails, WhatsApp
 * templates) and the web client, so a price renders identically everywhere.
 */

export function formatCurrency(value: number | null | undefined, currency = 'INR', locale = 'en-IN'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

/** Indian real-estate shorthand: ₹1.45 Cr, ₹85 L, ₹40,000. */
export function formatIndianPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= CRORE) {
    const cr = abs / CRORE;
    return `${sign}₹${trimZeros(cr.toFixed(2))} Cr`;
  }
  if (abs >= LAKH) {
    const l = abs / LAKH;
    return `${sign}₹${trimZeros(l.toFixed(2))} L`;
  }
  return `${sign}₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(abs)}`;
}

function trimZeros(s: string): string {
  return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function parseIndianPrice(input: string): number | null {
  if (!input) return null;
  const cleaned = input.replace(/[₹,\s]/gi, '').toLowerCase();
  const m = cleaned.match(/^([\d.]+)\s*(cr|crore|crores|l|lac|lakh|lakhs|k|thousand)?$/);
  if (!m) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  switch (m[2]) {
    case 'cr': case 'crore': case 'crores': return num * CRORE;
    case 'l': case 'lac': case 'lakh': case 'lakhs': return num * LAKH;
    case 'k': case 'thousand': return num * 1000;
    default: return num;
  }
}

export function formatArea(value: number | null | undefined, unit = 'sqft'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const labels: Record<string, string> = {
    sqft: 'sq.ft', sqm: 'sq.m', sqyd: 'sq.yd', acre: 'acre', hectare: 'ha',
  };
  return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)} ${labels[unit] ?? unit}`;
}

export function formatNumber(value: number | null | undefined, decimals = 0, locale = 'en-IN'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(decimals)}%`;
}

export function formatPhone(value: string | null | undefined): string {
  if (!value) return '—';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return value;
}

/** Normalise a phone number to E.164 for WhatsApp/telephony providers. */
export function toE164(value: string | null | undefined, defaultCountry = '91'): string | null {
  if (!value) return null;
  let digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  digits = digits.replace(/\D/g, '');
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return null;
}

/**
 * Combine a stored country code with a national number.
 *
 * Leads keep the two apart — `country_code` is a field the user picks and
 * `mobile` is ten digits — because a silent +91 default sends an NRI buyer's
 * WhatsApp to a stranger in India. Anything that needs a dialable number (a
 * wa.me link, a Cloud API send, a click-to-call) has to put them back together,
 * and this is the one place that knows how.
 *
 * Falls back to `toE164` when no code is supplied, so records written before
 * the split and modules without a country field still work.
 */
export function toInternational(
  countryCode: string | null | undefined,
  national: string | null | undefined,
): string | null {
  const digits = (national ?? '').replace(/\D/g, '');
  if (!digits) return null;

  // Already carries a country code — trust it over the field, since a number
  // stored in full is either legacy data or came from the provider itself.
  if ((national ?? '').trim().startsWith('+')) return `+${digits}`;

  const code = (countryCode ?? '').replace(/\D/g, '');
  if (!code) return toE164(digits);

  // A number that already begins with its own country code must not get a
  // second one: "+9191..." is how a lead becomes unreachable.
  if (digits.startsWith(code) && digits.length > code.length + 6) return `+${digits}`;
  return `+${code}${digits}`;
}

export function formatDate(value: string | Date | null | undefined, locale = 'en-IN'): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string | Date | null | undefined, locale = 'en-IN'): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60_000, 'second'],
    [3_600_000, 'minute'],
    [86_400_000, 'hour'],
    [604_800_000, 'day'],
    [2_592_000_000, 'week'],
    [31_536_000_000, 'month'],
    [Infinity, 'year'],
  ];
  const divisors = [1000, 60_000, 3_600_000, 86_400_000, 604_800_000, 2_592_000_000, 31_536_000_000];
  for (let i = 0; i < units.length; i++) {
    if (abs < units[i][0]) {
      const v = Math.round(abs / divisors[i]);
      const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
      return rtf.format(future ? v : -v, units[i][1]);
    }
  }
  return formatDate(d);
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic pastel colour from a string — used for avatars and tags. */
export function colorFromString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 48%)`;
}

export function truncate(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '_')
    .replace(/^-+|-+$/g, '');
}

/** Render "{{field}}" merge tags against a value bag. Used by templates + workflows. */
export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const val = path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, values);
    if (val === null || val === undefined) return '';
    return String(val);
  });
}
