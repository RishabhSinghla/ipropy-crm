import type { JSX } from 'react';
import { MessageCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { openExternal } from '../lib/nativeActions';
import { useWhatsAppComposer } from './WhatsAppComposer';
import { waDigits } from '../lib/whatsapp';
import { cn } from '../lib/utils';

/**
 * The WhatsApp way into a number, wherever that number is shown.
 *
 * It never leaves the CRM — that is the point of the official number: the
 * conversation stays where a manager can read it and the timeline records it.
 *
 * With a record in view it opens the composer over whatever the rep was doing,
 * because the question they want to ask is about the person already on screen
 * and the Chats queue is a detour. Everywhere else — a list of numbers with no
 * one record behind them — it still goes to Chats on that thread. Neither
 * sends anything by being clicked.
 *
 * It sits *before* the Call button by intent: the first thing a rep does with
 * a new enquiry is message it.
 */
export function WhatsAppIconButton({ to, className }: { to: string; className?: string }): JSX.Element | null {
  const composer = useWhatsAppComposer();
  const digits = waDigits(to);
  if (!digits) return null;
  const look = className ?? 'inline-flex items-center text-emerald-600 hover:text-emerald-700 dark:text-emerald-400';

  if (composer) {
    return (
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); composer.compose(digits); }}
        className={look}
        title="WhatsApp this number"
        aria-label="WhatsApp this number"
      >
        <MessageCircle className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <Link
      to={`/chats?to=${digits}`}
      onClick={(event) => event.stopPropagation()}
      className={look}
      title="WhatsApp this number"
      aria-label="WhatsApp this number"
    >
      <MessageCircle className="h-3.5 w-3.5" />
    </Link>
  );
}

/**
 * The record's own WhatsApp button, which leaves the CRM.
 *
 * Deliberately different from the icon above, on the owner's instruction: this
 * one hands the number to WhatsApp itself, so the rep writes there with their
 * own history and their own keyboard. `api.whatsapp.com/send/` rather than
 * `wa.me`: same hand-off, and it is the one the owner named. Only this button
 * leaves — the small icon beside a number stays inside the CRM. `openExternal`
 * rather than a plain link, because `window.open` returns null inside the phone
 * app and nothing happens.
 */
export function WhatsAppButton({ to, iconOnly = false, round = false }: { to: string; iconOnly?: boolean; round?: boolean }): JSX.Element | null {
  const digits = waDigits(to);
  if (!digits) return null;
  return (
    <button
      type="button"
      // `iconOnly` where the header is tight — the split view, above all. The
      // word costs a third of the strip for a button everybody recognises by
      // its shape, and the title still says what it does.
      // `round` is the split view's own shape: a plain circle in the
      // record's action strip, neutral at rest — four tinted circles in a
      // line read as four warnings — and filling with its own colour under
      // the cursor, so it says what it is exactly when that matters.
      className={round
        ? 'inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:border-transparent hover:text-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 hover:bg-emerald-600'
        : cn('btn-secondary btn-sm', iconOnly && 'h-9 w-9 justify-center px-0')}
      title={`WhatsApp ${to}`}
      aria-label={`WhatsApp ${to}`}
      onClick={() => void openExternal(`https://api.whatsapp.com/send/?phone=${digits}`)}
    >
      <MessageCircle className={round ? 'h-4 w-4' : 'h-3.5 w-3.5 text-emerald-600'} />
      {!iconOnly && !round && <span className="hidden sm:inline">WhatsApp</span>}
    </button>
  );
}
