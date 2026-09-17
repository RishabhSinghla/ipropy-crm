import type { JSX } from 'react';
import { MessageCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { openExternal } from '../lib/nativeActions';

/** Digits only — a handle is matched on digits, never on the spacing a screen adds. */
export function waDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * The WhatsApp way into a number, wherever that number is shown.
 *
 * It opens the CRM's own Chats screen on that thread — never `wa.me`, because
 * the point of the linked number is that the conversation stays in the CRM
 * where a manager can read it and the timeline records it. A number with no
 * thread yet still opens Chats; nothing is sent by clicking.
 *
 * It sits *before* the Call button by intent: the first thing a rep does with
 * a new enquiry is message it.
 */
export function WhatsAppIconButton({ to, className }: { to: string; className?: string }): JSX.Element | null {
  const digits = waDigits(to);
  if (!digits) return null;
  return (
    <Link
      to={`/chats?to=${digits}`}
      onClick={(event) => event.stopPropagation()}
      className={className ?? 'inline-flex items-center text-emerald-600 hover:text-emerald-700 dark:text-emerald-400'}
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
export function WhatsAppButton({ to }: { to: string }): JSX.Element | null {
  const digits = waDigits(to);
  if (!digits) return null;
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      title={`WhatsApp ${to}`}
      onClick={() => void openExternal(`https://api.whatsapp.com/send/?phone=${digits}`)}
    >
      <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />
      <span className="hidden sm:inline">WhatsApp</span>
    </button>
  );
}
