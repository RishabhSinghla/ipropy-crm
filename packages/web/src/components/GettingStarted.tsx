/**
 * What is left to do, on the screen somebody lands on.
 *
 * Not a wizard. A wizard assumes the person will go in the order it chose and
 * finish in one sitting, and the first thing anybody does with one is look for
 * the close button. This is a list of real state: every row is derived from the
 * database on each load, so ticking one requires actually doing the thing, and
 * a row that comes back has come back for a reason.
 *
 * It disappears on its own when everything is done and never returns unless
 * something genuinely regresses. Dismissing it is remembered per person, since
 * one rep hiding it should not hide it from somebody who has not started.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Circle, Rocket, X } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

interface Step {
  id: string; title: string; why: string; done: boolean;
  href: string; action: string; adminOnly: boolean;
}

const DISMISS_KEY = 'ipropy.gettingStarted.dismissed';

export default function GettingStarted(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');
  const { data } = useQuery({
    queryKey: ['getting-started'],
    queryFn: () => api.gettingStarted(),
    // Cheap, and it has to be right the moment somebody comes back from doing
    // one of these. A stale tick is worse than no checklist.
    staleTime: 0,
  });

  const steps = (data?.steps ?? []) as Step[];
  const done = steps.filter((s) => s.done).length;

  // Nothing to say when there is nothing left, and nothing to say before the
  // answer has arrived — a checklist that flashes "0 of 6" and then corrects
  // itself reads as the CRM having forgotten what you did.
  if (!steps.length || done === steps.length || dismissed) return null;

  const next = steps.find((s) => !s.done);

  return (
    <section className="card overflow-hidden">
      <div className="flex items-start gap-3 border-b border-slate-100 p-4 dark:border-slate-800">
        <span className="mt-0.5 rounded-lg bg-brand-50 p-1.5 dark:bg-brand-950">
          <Rocket className="h-4 w-4 text-brand-600 dark:text-brand-400" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Getting started</h2>
          <p className="mt-0.5 text-xs text-muted">
            {done} of {steps.length} done. Each one takes a minute, and the CRM does more for you after each.
          </p>
        </div>
        <button
          onClick={() => { localStorage.setItem(DISMISS_KEY, '1'); setDismissed(true); }}
          className="btn-ghost p-1 text-muted"
          title="Hide this"
          aria-label="Hide getting started"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="h-1 bg-slate-100 dark:bg-slate-800">
        <div
          className="h-full bg-brand-500 transition-all"
          style={{ width: `${Math.round((done / steps.length) * 100)}%` }}
        />
      </div>

      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {steps.map((step) => (
          <li key={step.id} className={cn('flex items-start gap-3 p-4', step.done && 'opacity-60')}>
            {step.done
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-positive" />
              : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-300 dark:text-slate-600" />}
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm font-medium', step.done && 'line-through')}>{step.title}</p>
              {!step.done && <p className="mt-0.5 text-xs text-muted">{step.why}</p>}
            </div>
            {!step.done && (
              <Link
                to={step.href}
                className={cn('btn-sm shrink-0', step.id === next?.id ? 'btn-primary' : 'btn-secondary')}
              >
                {step.action} <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
