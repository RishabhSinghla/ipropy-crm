/**
 * The small set of parts every screen in the app is built from.
 *
 * Deliberately not the web app's components. Those are shaped for a mouse, a
 * wide screen and a person who is sitting down: dense rows, hover states,
 * controls that assume a cursor can land on eight pixels. Re-skinning them
 * produces a website in a box, which is exactly what this is meant not to be.
 *
 * The rules these encode, which are the difference between "a mobile app" and
 * "a web page on a phone":
 *
 * - Nothing smaller than 44 points is tappable.
 * - A screen has one job and one obvious action.
 * - Lists are rows with an avatar, a name and one line of context — the shape
 *   of every messaging and contacts app anybody already has.
 * - Chrome that does not do something is not drawn.
 */
import { type JSX, type ReactNode, useEffect, useRef } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { tap } from '../lib/nativeActions';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/*
  Eight hues, picked by name.

  A contacts app gives every person a colour and it is the same colour every
  time, which is most of how you find somebody in a list without reading. Hue
  rather than a random palette so the set stays coherent, and fixed saturation
  and lightness so white text clears contrast on all eight.
*/
const HUES = [210, 268, 330, 12, 32, 152, 190, 250];

function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return HUES[Math.abs(hash) % HUES.length];
}

/** Initials the way a phone does it: first letter of the first two words. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function Avatar({
  name, size = 48, className,
}: { name: string; size?: number; className?: string }): JSX.Element {
  const hue = hueFor(name || '?');
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        backgroundColor: `hsl(${hue} 52% 46%)`,
      }}
      aria-hidden
    >
      {initialsOf(name)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen furniture
// ---------------------------------------------------------------------------

/**
 * The bar across the top of a screen.
 *
 * A back arrow, a title, and at most two actions. Not a toolbar: the web app's
 * header carries six controls and a search box, and on a phone that is a row of
 * targets nobody can hit and a title nobody can read.
 */
export function AppBar({
  title, subtitle, onBack, actions, large,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  actions?: ReactNode;
  /** The iOS-style oversized title, for a screen that is a destination. */
  large?: boolean;
}): JSX.Element {
  return (
    <header className="sticky top-0 z-20 shrink-0 bg-[var(--surface)]/95 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-1 px-1">
        {onBack && (
          <button
            type="button"
            onClick={() => { void tap(); onBack(); }}
            className="flex h-11 w-11 items-center justify-center rounded-full text-brand-600 active:bg-slate-500/10 dark:text-brand-400"
            aria-label="Back"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {/*
          Under a large title the compact one is not drawn, but the space it
          occupied still has to be — otherwise the actions slide to the left
          edge and sit where the back arrow goes on every other screen.
        */}
        {large ? (
          <div className="flex-1" />
        ) : (
          <div className={cn('min-w-0 flex-1', onBack ? 'px-1' : 'px-3')}>
            <p className="truncate text-[17px] font-semibold leading-tight">{title}</p>
            {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
          </div>
        )}
        <div className="flex items-center gap-0.5 pr-1">{actions}</div>
      </div>

      {/*
        The large title sits below the bar rather than inside it, so it can
        scroll away while the compact one above stays. Two elements rather than
        one animated size, because a font-size transition on scroll janks on a
        mid-range Android and this does not move at all.
      */}
      {large && (
        <div className="px-4 pb-2">
          <h1 className="text-[30px] font-bold leading-tight tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
      )}
    </header>
  );
}

/** A round action in an AppBar. */
export function BarButton({
  icon, label, onClick, tone = 'default',
}: {
  icon: ReactNode; label: string; onClick: () => void; tone?: 'default' | 'brand';
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => { void tap(); onClick(); }}
      aria-label={label}
      className={cn(
        'flex h-11 w-11 items-center justify-center rounded-full active:bg-slate-500/10',
        tone === 'brand' ? 'text-brand-600 dark:text-brand-400' : 'text-slate-600 dark:text-slate-300',
      )}
    >
      {icon}
    </button>
  );
}

/**
 * The big round button every phone app puts a new thing behind.
 *
 * Bottom right, above the tab bar, thumb-reachable one-handed. `--bottom-nav-h`
 * is published by the tab bar itself so this cannot drift out of position when
 * the bar's height changes.
 */
export function Fab({ onClick, label, icon }: { onClick: () => void; label: string; icon: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => { void tap('medium'); onClick(); }}
      aria-label={label}
      // A slate shadow, not a brand-tinted one: the brand scale is CSS
      // variables and Tailwind's opacity modifier cannot compose a colour from
      // one, so `shadow-brand-600/30` resolved to nothing at all.
      className="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg shadow-slate-900/20 transition-transform active:scale-95"
      style={{ bottom: 'calc(var(--bottom-nav-h, 0px) + 16px)' }}
    >
      {icon}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One line in a list of things — a contact, a setting, a unit.
 *
 * The divider is inset to the text, not the screen edge, which is what every
 * native list does and is the single cheapest way to stop a list looking like
 * a table.
 */
export function Row({
  leading, title, subtitle, trailing, onClick, bold, className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  bold?: boolean;
  className?: string;
}): JSX.Element {
  const content = (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-[16px] leading-snug', bold ? 'font-semibold' : 'font-medium')}>{title}</div>
        {subtitle !== undefined && (
          <div className="mt-0.5 truncate text-[13px] leading-snug text-muted">{subtitle}</div>
        )}
      </div>
      {trailing && <div className="shrink-0 text-right">{trailing}</div>}
    </>
  );

  if (!onClick) {
    return <div className={cn('flex items-center gap-3 px-4 py-2.5', className)}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => { void tap(); onClick(); }}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-2.5 text-left active:bg-slate-500/10',
        className,
      )}
    >
      {content}
    </button>
  );
}

/** A group of rows with a quiet heading, the way a phone's own settings look. */
export function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: string }): JSX.Element {
  return (
    <section className="mt-6 first:mt-2">
      {title && (
        <h2 className="px-4 pb-1.5 text-[13px] font-medium uppercase tracking-wide text-muted">{title}</h2>
      )}
      <div className="divide-y divide-[var(--border)] border-y border-[var(--border)] bg-[var(--surface)]">
        {children}
      </div>
      {footer && <p className="px-4 pt-2 text-[13px] leading-snug text-muted">{footer}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/**
 * A panel that comes up from the bottom.
 *
 * The phone answer to a dialog. It is where every edit in this app happens,
 * because a sheet keeps the record visible behind it — you can see what you are
 * changing — and it puts its controls under the thumb rather than in the middle
 * of the screen.
 *
 * Android's back button closes it before it reaches the router; `ipropy:back`
 * is dispatched by the hardware-back bridge and cancelled here to say so.
 */
export function Sheet({
  open, onClose, title, children, action,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const swallowBack = (e: Event): void => { e.preventDefault(); onClose(); };
    document.addEventListener('ipropy:back', swallowBack);
    return () => document.removeEventListener('ipropy:back', swallowBack);
  }, [open, onClose]);

  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-950/40"
        onClick={onClose}
      />
      <div
        ref={ref}
        className="relative max-h-[88vh] overflow-y-auto rounded-t-2xl bg-[var(--surface)] pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl"
        style={{ animation: 'ipropy-sheet-up 220ms cubic-bezier(0.32,0.72,0,1)' }}
      >
        {/* The grab handle. It does nothing; it is how a person knows the
            panel is dismissible without being told. */}
        <div className="flex justify-center pt-2.5">
          <div className="h-1 w-9 rounded-full bg-slate-300 dark:bg-slate-600" />
        </div>

        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-500 active:bg-slate-500/10"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
          <p className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</p>
          {action}
        </div>

        <div className="px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}
