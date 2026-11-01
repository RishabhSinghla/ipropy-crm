import type { JSX } from 'react';
import { Check } from 'lucide-react';
import { BUBBLE_STYLE, type BubbleKind } from '../lib/whatsapp';
import { cn } from '../lib/utils';

const KINDS = Object.keys(BUBBLE_STYLE) as BubbleKind[];

/**
 * The four colour chips as filters. Nothing pressed shows everything; press one
 * or several to show only those kinds. The caller owns the selection so it can
 * reset it when the record changes.
 */
export function BubbleKindFilter({ active, counts, onChange }: {
  active: ReadonlySet<BubbleKind>;
  counts: Record<BubbleKind, number>;
  onChange: (next: Set<BubbleKind>) => void;
}): JSX.Element {
  const toggle = (kind: BubbleKind): void => {
    const next = new Set(active);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    onChange(next);
  };
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter messages by kind">
      {KINDS.map((kind) => {
        const pressed = active.has(kind);
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={pressed}
            onClick={() => toggle(kind)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-900 dark:focus-visible:outline-white',
              BUBBLE_STYLE[kind].chip,
              pressed ? 'ring-2 ring-slate-900 dark:ring-white' : active.size > 0 && 'opacity-60 hover:opacity-100',
            )}
          >
            {pressed && <Check className="h-3 w-3" aria-hidden />}
            {BUBBLE_STYLE[kind].label}
            <span className="tabular-nums opacity-80">{counts[kind]}</span>
          </button>
        );
      })}
      {active.size > 0 && (
        <button
          type="button"
          onClick={() => onChange(new Set())}
          className="text-[10px] font-semibold text-muted underline hover:text-brand-600"
        >
          Clear
        </button>
      )}
    </div>
  );
}

export function countKinds<T>(messages: T[], kindOf: (m: T) => BubbleKind): Record<BubbleKind, number> {
  const counts: Record<BubbleKind, number> = { 'api-out': 0, 'api-in': 0, 'chat-out': 0, 'chat-in': 0 };
  for (const m of messages) counts[kindOf(m)] += 1;
  return counts;
}

export interface NumberOption { id: string; label: string }

/** The distinct numbers of ours that carried messages in this thread, for the "number" filter chips. */
export function numbersIn(messages: Array<{ numberId?: string | null; numberName?: string | null; numberPhone?: string | null }>): NumberOption[] {
  const seen = new Map<string, string>();
  for (const m of messages) {
    if (!m.numberId || seen.has(m.numberId)) continue;
    seen.set(m.numberId, [m.numberName, m.numberPhone].filter(Boolean).join(' · ') || 'Unknown number');
  }
  return [...seen].map(([id, label]) => ({ id, label }));
}

/** Multi-select of our numbers (shown only when the thread used more than one). Nothing pressed shows all. */
export function NumberFilter({ options, active, onChange }: {
  options: NumberOption[]; active: ReadonlySet<string>; onChange: (next: Set<string>) => void;
}): JSX.Element | null {
  if (options.length < 2) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter messages by our number">
      <span className="text-[10px] font-semibold text-muted">Number</span>
      {options.map((o) => {
        const pressed = active.has(o.id);
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={pressed}
            onClick={() => { const next = new Set(active); if (pressed) next.delete(o.id); else next.add(o.id); onChange(next); }}
            className={cn(
              'inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-800 dark:bg-slate-800 dark:text-slate-100',
              pressed ? 'ring-2 ring-slate-900 dark:ring-white' : active.size > 0 && 'opacity-60 hover:opacity-100',
            )}
          >
            {pressed && <Check className="h-3 w-3" aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
