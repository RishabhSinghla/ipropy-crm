import { type JSX, type ReactNode } from 'react';
import { recordStrength, type FieldMeta } from '@ipropy/shared';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * How full a record is, drawn as a ring around whatever it wraps.
 *
 * Three bands rather than a gradient: a rep needs to know whether this record
 * is worth calling, not its exact score. The colours are the same three the
 * follow-up chips use, so red always means "this needs you".
 *
 * Fixed hues rather than tokens on purpose — like the due chips, this is the
 * app's own vocabulary, not a colour an admin chose, so there is no hex to
 * push through `badgeVars`.
 */
const BANDS = [
  {
    min: 80, stroke: '#16a34a', text: 'text-emerald-700 dark:text-emerald-400', word: 'Strong',
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  },
  {
    min: 50, stroke: '#d97706', text: 'text-amber-700 dark:text-amber-400', word: 'Partly filled',
    badge: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  },
  {
    min: 0, stroke: '#dc2626', text: 'text-red-700 dark:text-red-400', word: 'Thin',
    badge: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
  },
] as const;

function band(percent: number): typeof BANDS[number] {
  return BANDS.find((b) => percent >= b.min) ?? BANDS[BANDS.length - 1];
}

/** The spoken and hovered description: the number, then what would raise it. */
function describe(percent: number, missing: { label: string }[]): string {
  if (!missing.length) return `Form strength ${percent}% — nothing left to fill in`;
  const names = missing.slice(0, 5).map((m) => m.label).join(', ');
  const more = missing.length > 5 ? `, and ${missing.length - 5} more` : '';
  return `Form strength ${percent}% — still missing ${names}${more}`;
}

export function StrengthRing({
  fields, values, size = 22, showPercent = false, cornerBadge = false, className, children,
}: {
  fields: FieldMeta[];
  values: Record<string, unknown>;
  /** The diameter of what sits inside the ring, not of the ring itself. */
  size?: number;
  showPercent?: boolean;
  /**
   * The number tucked into the ring's bottom-right corner rather than beside
   * it — how a rep reads a whole column of them without the name losing width.
   * A finished record shows a tick: 100% needs no arithmetic.
   */
  cornerBadge?: boolean;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const { percent, missing } = recordStrength(fields, values);
  const tone = band(percent);
  const label = describe(percent, missing);

  // The ring sits outside the avatar, so the drawing is wider than the thing
  // it measures. Stroke on the centre line of the circle, hence the half.
  const stroke = Math.max(3, Math.round(size / 8));
  const outer = size + stroke * 2 + 2;
  const r = (outer - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <span className={cn('inline-flex items-center gap-1 align-middle', className)}>
      <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: outer, height: outer }}>
        <svg width={outer} height={outer} viewBox={`0 0 ${outer} ${outer}`} role="img" aria-label={label} className="absolute inset-0">
          <title>{label}</title>
          <circle cx={outer / 2} cy={outer / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-slate-200 dark:stroke-slate-700" />
          <circle
            cx={outer / 2} cy={outer / 2} r={r} fill="none" strokeWidth={stroke} stroke={tone.stroke} strokeLinecap="round"
            strokeDasharray={`${(circumference * percent) / 100} ${circumference}`}
            transform={`rotate(-90 ${outer / 2} ${outer / 2})`}
          />
        </svg>
        <span className="relative inline-flex">{children}</span>
        {cornerBadge && (
          percent === 100 ? (
            <span
              className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white ring-1 ring-white dark:ring-slate-900"
              title={label}
            >
              <Check className="h-2 w-2" strokeWidth={4} />
              <span className="sr-only">{label}</span>
            </span>
          ) : (
            <span
              className={cn(
                'absolute -bottom-1 -right-1 rounded-full border px-1 py-px text-[8px] font-bold leading-none tabular-nums ring-1 ring-white dark:ring-slate-900',
                tone.badge,
              )}
              title={label}
            >
              {/* The % sign stays: a bare "17" in the corner of a face reads
                  as a count of something, not as how full the record is. */}
              {percent}%
              <span className="sr-only"> — {label}</span>
            </span>
          )
        )}
      </span>
      {showPercent && (
        <span className={cn('text-xs font-semibold tabular-nums', tone.text)} title={label}>
          {percent}%
          <span className="sr-only"> form strength, {tone.word}</span>
        </span>
      )}
    </span>
  );
}

/**
 * The same number, as a plain chip — no face, no ring.
 *
 * What a list column needs: the owner asked for the avatar to go, because a
 * coloured circle with initials, a ring and a badge tucked in its corner is
 * three things competing where one number was wanted.
 *
 * **Two pastel tones and no more**, also on his instruction. The split is at
 * 70%: above it the record is worth calling, below it somebody has to fill it
 * in. A third tone would put the column back to being read rather than
 * glanced at.
 */
const CHIP = {
  full: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  thin: 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
} as const;

export function StrengthChip({ fields, values, className }: {
  fields: FieldMeta[];
  values: Record<string, unknown>;
  className?: string;
}): JSX.Element {
  const { percent, missing } = recordStrength(fields, values);
  const label = describe(percent, missing);
  return (
    <span
      className={cn(
        'inline-flex h-6 w-10 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums',
        percent >= 70 ? CHIP.full : CHIP.thin,
        className,
      )}
      title={label}
      /*
        Announced as one value, not as the digits on screen: "17%" read aloud
        on its own says nothing about what it measures or what would raise it.
      */
      role="img"
      aria-label={label}
    >
      {percent}%
    </span>
  );
}
