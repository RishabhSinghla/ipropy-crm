import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, ChevronDown, Info, Loader2, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useToasts } from '../lib/store';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }): JSX.Element {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} />;
}

export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <div className={cn('skeleton', className)} />;
}

export function EmptyState({
  icon, title, body, action,
}: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-slate-300 dark:text-slate-700">{icon}</div>}
      <div>
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">{title}</p>
        {body && <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-500">{body}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({
  children, color, className,
}: { children: ReactNode; color?: string | null; className?: string }): JSX.Element {
  return (
    <span
      className={cn('badge border', className, !color && 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300')}
      style={color ? { backgroundColor: `${color}18`, color, borderColor: `${color}35` } : undefined}
    >
      {children}
    </span>
  );
}

export function Avatar({
  name, src, size = 32, className,
}: { name: string; src?: string | null; size?: number; className?: string }): JSX.Element {
  const initials = name
    ? name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase()
    : '?';
  // Deterministic hue so the same person is always the same colour.
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;

  if (src) {
    return <img src={src} alt={name} width={size} height={size} className={cn('rounded-full object-cover', className)} />;
  }
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ width: size, height: size, backgroundColor: `hsl(${hue}, 55%, 45%)`, fontSize: size * 0.38 }}
      title={name}
    >
      {initials}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open, onClose, title, children, footer, size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Prevent the page behind the modal from scrolling.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl', full: 'max-w-[95vw]' };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('relative z-10 w-full animate-slide-up rounded-xl bg-white shadow-float dark:bg-slate-900', widths[size])}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-ghost -mr-2 p-1.5" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger,
}: {
  open: boolean; onClose: () => void;
  /** The resolved value is ignored, so callers can pass a mutation directly. */
  onConfirm: () => unknown | Promise<unknown>;
  title: string; body?: string; confirmLabel?: string; danger?: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open} onClose={onClose} title={title} size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={danger ? 'btn-danger' : 'btn-primary'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(); onClose(); } finally { setBusy(false); }
            }}
          >
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-600 dark:text-slate-400">{body}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

export function Dropdown({
  trigger, children, align = 'right', className,
}: { trigger: ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: 'left' | 'right'; className?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          className={cn(
            'absolute z-40 mt-1 min-w-[12rem] animate-slide-up overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-float dark:border-slate-700 dark:bg-slate-900',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

export function DropdownItem({
  children, onClick, danger, icon, disabled,
}: { children: ReactNode; onClick?: () => void; danger?: boolean; icon?: ReactNode; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-40',
        danger
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40'
          : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function Tabs({
  tabs, active, onChange, className,
}: {
  tabs: { key: string; label: string; icon?: ReactNode; count?: number }[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            active === tab.key
              ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
          )}
        >
          {tab.icon}
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span className="rounded-full bg-slate-100 px-1.5 text-2xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-400">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select (native, styled)
// ---------------------------------------------------------------------------

export function Select({
  value, onChange, options, placeholder, className, disabled,
}: {
  value: string | null | undefined;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="relative">
      <select
        className={cn('input appearance-none pr-8', className)}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function ToastHost(): JSX.Element {
  const { toasts, dismiss } = useToasts();
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex animate-slide-up items-start gap-2.5 rounded-lg border p-3 shadow-float',
            t.kind === 'success' && 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950',
            t.kind === 'error' && 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950',
            t.kind === 'info' && 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
          )}
        >
          <div className="mt-0.5 shrink-0">
            {t.kind === 'success' && <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
            {t.kind === 'error' && <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />}
            {t.kind === 'info' && <Info className="h-4 w-4 text-slate-500" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t.title}</p>
            {t.body && <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">{t.body}</p>}
          </div>
          <button onClick={() => dismiss(t.id)} className="shrink-0 text-slate-400 hover:text-slate-600">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function Toggle({
  checked, onChange, label, disabled, className,
}: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; className?: string }): JSX.Element {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2', disabled && 'cursor-not-allowed opacity-50', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-700',
        )}
      >
        <span
          // `left-0.5` is required, not decorative: buttons get `text-align:
          // center` from Preflight, so an absolutely-positioned span with no
          // explicit inset resolves its static position to the button's
          // horizontal center (an empty inline box centers to a single
          // point). Without `left-0.5` pinning it, the translate-x below
          // stacks on top of that centred point instead of the track's edge,
          // and the thumb ends up rendered outside the pill when checked.
          className={cn(
            'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </button>
      {label && <span className="text-sm text-slate-700 dark:text-slate-300">{label}</span>}
    </label>
  );
}

export function ProgressBar({ value, max = 100, color }: { value: number; max?: number; color?: string }): JSX.Element {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: color ?? '#6366f1' }}
      />
    </div>
  );
}

/** Score chip with a colour ramp — used for lead scores and deal risk. */
export function ScoreChip({ score, invert }: { score: number | null | undefined; invert?: boolean }): JSX.Element | null {
  if (score === null || score === undefined) return null;
  const effective = invert ? 100 - score : score;
  const color = effective >= 75 ? '#22c55e' : effective >= 50 ? '#f59e0b' : effective >= 25 ? '#f97316' : '#ef4444';
  return (
    <span
      className="inline-flex h-6 min-w-[2.25rem] items-center justify-center rounded-md px-1.5 text-xs font-semibold tnum"
      style={{ backgroundColor: `${color}1a`, color }}
      title={invert ? `Risk score ${score}` : `Score ${score}/100`}
    >
      {score}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------

export function Input({
  value, onChange, type = 'text', placeholder, error, className, autoFocus, ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { error?: string; autoFocus?: boolean }): JSX.Element {
  return (
    <div className="space-y-1">
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={cn('input', error && 'border-red-300 focus:ring-red-500 focus:border-red-500', className)}
        {...rest}
      />
      {error && <p className="text-2xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function Textarea({
  value, onChange, placeholder, rows = 3, error, className, ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: string }): JSX.Element {
  return (
    <div className="space-y-1">
      <textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={rows}
        className={cn('input resize-none', error && 'border-red-300 focus:ring-red-500 focus:border-red-500', className)}
        {...rest}
      />
      {error && <p className="text-2xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div className={cn('card', className)} {...rest}>
      {children}
    </div>
  );
}
