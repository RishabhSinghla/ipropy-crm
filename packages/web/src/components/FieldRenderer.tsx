import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
/**
 * Metadata-driven field rendering.
 *
 * `FieldValue` renders a stored value read-only; `FieldInput` renders the right
 * editor for a uitype. Every list, detail and form screen in the app goes
 * through these two components, which is why adding a field in the admin panel
 * immediately works everywhere without touching the UI.
 */
import {
  expectedDigits, formatArea, formatDate, formatDateTime, formatIndianPrice, formatPhone,
  type FieldMeta,
} from '@ipropy/shared';
import {
  Check, ChevronDown, ExternalLink, ImagePlus, Loader2, Mail, MapPin, Phone, Search, Video, X,
} from 'lucide-react';
import { api, tokenStore } from '../lib/api';
import { optionsWithValue } from '../lib/picklistOptions';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { Avatar, Badge, ScoreChip } from './ui';
import { PeekLink } from './PeekLink';
import { useCallDisposition } from './CallDisposition';

/**
 * A plain <img src> can't carry the app's Authorization header, and
 * GET /api/files/:id is permission-checked — so image previews use the same
 * ?access_token= fallback requireAuth already supports for other embeds
 * (see middleware/auth.ts's extractToken; api.ts's CSV export uses the same
 * pattern). Without this, every gallery thumbnail 401s.
 */
function authedImageUrl(url: string, size?: 'thumb' | 'medium' | 'large'): string {
  const params = new URLSearchParams();
  if (size) params.set('size', size);
  const token = tokenStore.get();
  if (token) params.set('access_token', token);
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

// ---------------------------------------------------------------------------
// Read-only display
// ---------------------------------------------------------------------------

export function FieldValue({
  field, value, display, compact, linkTo,
}: {
  field: FieldMeta;
  value: unknown;
  display?: string;
  compact?: boolean;
  /** module of a reference target, for building a link */
  linkTo?: string;
}): JSX.Element {
  const callDisposition = useCallDisposition();
  const empty = value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0);

  if (empty) return <span className="text-slate-300 dark:text-slate-700">—</span>;

  switch (field.uitype) {
    case 'currency':
      // A budget/demand carries its per-unit qualifier in `display` — the same
      // deal as the area pair above.
      return <span className="font-medium tnum">{display || formatIndianPrice(Number(value))}</span>;

    case 'area':
      // `display` carries the unit when the field has one of its own
      // (config.unitField); a fixed-unit area falls back to config.unit.
      return <span className="tnum">{display || formatArea(Number(value), (field.config.unit as string) ?? 'sqft')}</span>;

    case 'percent':
      return <span className="tnum">{Number(value).toFixed(field.config.decimals as number ?? 1)}%</span>;

    case 'integer':
    case 'decimal':
      return <span className="tnum">{new Intl.NumberFormat('en-IN').format(Number(value))}</span>;

    case 'score':
      return <ScoreChip score={Number(value)} invert={field.name.includes('risk')} />;

    case 'boolean':
      return value
        ? <Check className="h-4 w-4 text-positive" />
        : <span className="text-slate-300 dark:text-slate-700">—</span>;

    case 'date':
      return <span className="tnum">{formatDate(String(value))}</span>;

    case 'datetime':
      return <span className="tnum">{formatDateTime(String(value))}</span>;

    case 'email':
      return (
        <a href={`mailto:${value}`} className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
          {!compact && <Mail className="h-3 w-3" />}
          {String(value)}
        </a>
      );

    case 'phone': {
      // The server joins the country code onto the number (see
      // resolveDisplayValues), so this shows one value — "+91 9811533636" —
      // instead of a bare ten digits beside a separate Country chip.
      const shown = display || formatPhone(String(value));
      // Plain text colour, like the name beside it. The number used to sit in
      // the brand blue, which read as decoration on something reps dial from.
      // Still a link, still underlines on hover, no longer shouting.
      return callDisposition ? (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); void callDisposition.startCall(String(value)); }}
          className="inline-flex items-center gap-1 text-left text-slate-900 hover:underline dark:text-slate-100 tnum"
          title={`Call ${shown}`}
        >
          {!compact && <Phone className="h-3 w-3" />}
          {shown}
        </button>
      ) : (
        <a
          href={`tel:${shown.replace(/[^\d+]/g, '') || value}`}
          className="inline-flex items-center gap-1 text-slate-900 hover:underline dark:text-slate-100 tnum"
        >
          {!compact && <Phone className="h-3 w-3" />}
          {shown}
        </a>
      );
    }

    case 'url':
      return (
        <a
          href={String(value)} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
        >
          {truncate(String(value).replace(/^https?:\/\//, ''), 40)}
          <ExternalLink className="h-3 w-3" />
        </a>
      );

    case 'picklist':
    case 'radio': {
      const option = field.options?.find((o) => o.value === value);
      return <Badge color={option?.color}>{option?.label ?? String(value)}</Badge>;
    }

    case 'multipicklist':
    case 'tags': {
      const list = Array.isArray(value) ? value : [];
      const shown = compact ? list.slice(0, 2) : list;
      return (
        <span className="inline-flex flex-wrap items-center gap-1">
          {shown.map((v) => {
            const option = field.options?.find((o) => o.value === v);
            return <Badge key={String(v)} color={option?.color}>{option?.label ?? String(v)}</Badge>;
          })}
          {compact && list.length > 2 && (
            <span className="text-2xs text-muted">+{list.length - 2}</span>
          )}
        </span>
      );
    }

    case 'reference': {
      const label = display || String(value);
      if (linkTo) {
        // The single most useful peek in the CRM: a lead says "Interested In:
        // Skyline Aurum" and the question is always what that unit is. Reading
        // it otherwise means leaving the lead and coming back.
        return (
          <PeekLink
            module={linkTo}
            id={String(value)}
            label={label}
            className="text-brand-600 hover:underline [-webkit-touch-callout:none] dark:text-brand-400"
          >
            {label}
          </PeekLink>
        );
      }
      return <span>{label}</span>;
    }

    case 'multireference':
      return <span>{display || (Array.isArray(value) ? value.length : 0) + ' linked'}</span>;

    case 'owner':
    case 'user':
      return display
        ? (
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={display} size={compact ? 18 : 22} />
            <span className="truncate">{display}</span>
          </span>
        )
        // A dash, like every other empty field on the page. "Unassigned" read
        // as a state somebody had chosen; it is only an old record nobody has
        // handed on yet.
        : <span className="text-muted">—</span>;

    case 'address': {
      const a = value as Record<string, unknown>;
      const parts = [a.street, a.locality, a.city, a.state, a.pincode].filter(Boolean).join(', ');
      return (
        <span className="inline-flex items-start gap-1">
          {!compact && <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />}
          <span>{parts || '—'}</span>
        </span>
      );
    }

    case 'textarea':
    case 'richtext':
      return compact
        ? <span className="text-muted">{truncate(String(value), 60)}</span>
        : <span className="whitespace-pre-wrap text-slate-700 dark:text-slate-300">{String(value)}</span>;

    case 'image': {
      const urls = Array.isArray(value) ? value : [value];
      return (
        <span className="inline-flex gap-1">
          {urls.slice(0, 3).map((u, i) => (
            <img
              key={i}
              src={authedImageUrl(String(u), 'thumb')}
              alt=""
              className="h-8 w-8 rounded object-cover"
              onError={(e) => { (e.target as HTMLImageElement).src = authedImageUrl(String(u)); }}
            />
          ))}
        </span>
      );
    }

    case 'json':
      return <code className="text-2xs text-muted">{truncate(JSON.stringify(value), compact ? 30 : 120)}</code>;

    case 'autonumber':
      return <span className="font-mono text-xs text-muted">{String(value)}</span>;

    // Computed fields carry no uitype of their own, so they fell through to
    // the default below and rendered as a bare String() — which is why an
    // all-inclusive unit price showed as "11888410" instead of "₹1.19 Cr".
    // Their declared config already says how to read the result (money via
    // `currency`, an area unit via `unit`), so honour it the same way the
    // concrete numeric uitypes above do.
    case 'formula':
    case 'rollup': {
      const n = Number(value);
      if (!Number.isFinite(n)) return <span>{compact ? truncate(String(value), 50) : String(value)}</span>;
      if (field.config.currency) return <span className="font-medium tnum">{formatIndianPrice(n)}</span>;
      if (field.config.unit) return <span className="tnum">{formatArea(n, field.config.unit)}</span>;
      return <span className="tnum">{new Intl.NumberFormat('en-IN').format(n)}</span>;
    }

    default:
      return <span>{compact ? truncate(String(value), 50) : String(value)}</span>;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

export interface FieldInputProps {
  field: FieldMeta;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
  disabled?: boolean;
  /** other values in the form, for dependent picklists and visibility rules */
  formValues?: Record<string, unknown>;
  /**
   * Write to a *different* field of the same record.
   *
   * A couple of controls own two stored values: a mobile carries its country
   * code, an area carries its unit. Both read better as one control with a
   * dropdown welded to it than as two form rows, which is how every other site
   * presents them — so the control needs a way to write the companion field.
   * Callers that cannot do that (an inline edit of a single cell) simply omit
   * it and the companion renders as a static prefix/suffix.
   */
  onChangeOther?: (field: string, value: unknown) => void;
  /** allowed values when a dependency narrows this picklist */
  restrictTo?: string[];
  autoFocus?: boolean;
  /** record/module context for the 'image' uitype's uploads (permission check + attachment linkage) */
  recordId?: string;
  moduleName?: string;
  /**
   * DOM id for the rendered control, so a caller's <label htmlFor> actually
   * points at something. RecordForm has always emitted `f_<field>` labels;
   * without this they referenced nothing, leaving every form field unlabelled
   * for screen readers and unfindable by accessible name.
   */
  id?: string;
}

export function FieldInput(props: FieldInputProps): JSX.Element {
  const { field, value, onChange, error, disabled, restrictTo, autoFocus, id } = props;
  const readOnly = disabled || field.isReadonly || field.displayType === 'readonly';

  const options = useMemo(() => {
    const all = field.options ?? [];
    return restrictTo?.length ? all.filter((o) => restrictTo.includes(o.value)) : all;
  }, [field.options, restrictTo]);

  const inputClass = cn('input', error && 'border-red-400 focus:border-red-500 focus:ring-red-500');

  switch (field.uitype) {
    case 'textarea':
      return (
        <textarea
          id={id}
          className={inputClass}
          rows={(field.config.rows as number) ?? 3}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          disabled={readOnly}
          placeholder={field.config.placeholder as string}
          autoFocus={autoFocus}
        />
      );

    case 'richtext':
      return (
        <textarea
          id={id}
          className={cn(inputClass, 'font-mono text-xs')}
          rows={(field.config.rows as number) ?? 6}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          disabled={readOnly}
          autoFocus={autoFocus}
        />
      );

    // An area whose unit is a field of its own gets the combined control; one
    // with a fixed unit is just a number, like the rest of this group.
    case 'area':
      if (field.config.unitField) return <AreaInput {...props} readOnly={readOnly} className={inputClass} />;
      return (
        <input
          id={id}
          type="number"
          className={cn(inputClass, 'tnum')}
          value={value === null || value === undefined ? '' : String(value)}
          step="any"
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          disabled={readOnly}
          autoFocus={autoFocus}
        />
      );

    case 'integer':
    case 'decimal':
    case 'percent':
    case 'score':
      return (
        <input
          id={id}
          type="number"
          className={cn(inputClass, 'tnum')}
          value={value === null || value === undefined ? '' : String(value)}
          step={field.uitype === 'integer' ? 1 : 'any'}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          disabled={readOnly}
          autoFocus={autoFocus}
        />
      );

    case 'currency':
      return <CurrencyInput {...props} readOnly={readOnly} className={inputClass} />;

    case 'boolean':
      return (
        <label className="inline-flex cursor-pointer items-center gap-2 py-1.5">
          <input
            id={id}
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={readOnly}
          />
          <span className="text-sm text-muted">{field.helpText ?? 'Yes'}</span>
        </label>
      );

    case 'date':
      return (
        <input
          id={id}
          type="date"
          className={inputClass}
          value={value ? String(value).slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={readOnly}
          autoFocus={autoFocus}
        />
      );

    case 'datetime':
      return (
        <input
          id={id}
          type="datetime-local"
          className={inputClass}
          value={value ? toLocalInput(String(value)) : ''}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
          disabled={readOnly}
          autoFocus={autoFocus}
        />
      );

    case 'time':
      return (
        <input
          id={id}
          type="time" className={inputClass} value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value || null)} disabled={readOnly}
        />
      );

    case 'picklist': {
      // A stored value no option backs — a locality from before the picklist
      // knew that city, a deleted option — must still render: a select with
      // no matching option shows blank, and the next save writes that blank
      // over the record. Same rule the phone control applies to a stored
      // country code whose option was deleted.
      const opts = optionsWithValue(options, value);
      return (
        <div className="relative">
          <select
            id={id}
            className={cn(inputClass, 'appearance-none pr-8')}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value || null)}
            disabled={readOnly}
            autoFocus={autoFocus}
          >
            <option value="">— Select —</option>
            {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>
      );
    }

    case 'radio': {
      const opts = optionsWithValue(options, value);
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-2" role="radiogroup" aria-label={field.label}>
          {opts.map((option) => (
            <label key={option.value} className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
              <input type="radio" name={id} value={option.value} checked={String(value ?? '') === option.value}
                onChange={() => onChange(option.value)} disabled={readOnly} autoFocus={autoFocus && String(value ?? '') === option.value} />
              {option.label}
            </label>
          ))}
        </div>
      );
    }

    case 'multipicklist':
      return <MultiSelect options={options} value={(value as string[]) ?? []} onChange={onChange} disabled={readOnly} />;

    case 'tags':
      return <TagInput value={(value as string[]) ?? []} onChange={onChange} disabled={readOnly} />;

    case 'reference':
      return <ReferencePicker field={field} value={value as string | null} onChange={onChange} disabled={readOnly} error={error} />;

    case 'owner':
    case 'user':
      return <UserPicker id={id} label={field.label} value={value as string | null} onChange={onChange} disabled={readOnly} />;

    case 'address':
      return <AddressInput value={value as Record<string, unknown> | null} onChange={onChange} disabled={readOnly} />;

    case 'email':
      return (
        <input
          id={id}
          type="email" className={inputClass} value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value || null)} disabled={readOnly}
          placeholder="name@example.com" autoFocus={autoFocus}
        />
      );

    case 'phone': {
      /**
       * One control: country code, then the national number.
       *
       * The code is not a separate question. This business dials one country,
       * so `codePrefix` on the field is painted on the front of the box and
       * nobody fills it in — created, read, updated or deleted, the number is
       * ten digits and the +91 is simply always there. A module that does keep
       * a country field (`digitsFrom`) still gets the dropdown, welded to the
       * left of the box the way every other site asks for a phone; where the
       * caller can't write a second field, that degrades to a static prefix.
       */
      const codeField = field.config.digitsFrom ? String(field.config.digitsFrom) : '';
      const prefix = String(field.config.codePrefix ?? '');
      const code = codeField ? String(props.formValues?.[codeField] ?? prefix) : prefix;
      const offered = field.config.countryCodes ?? [];
      /**
       * A code stored before its option was deleted still has to render.
       * Without it the <select> has no matching option, shows blank, and the
       * first stray change silently rewrites an NRI buyer's country.
       */
      const codes = code && !offered.some((c) => c.value === code)
        ? [...offered, { value: code, label: code }]
        : offered;
      // One country is not a choice. When the admin has narrowed the picklist
      // to +91 the dropdown is pure furniture, so it becomes a plain prefix.
      const editableCode = Boolean(codeField && codes.length > 1 && props.onChangeOther && !readOnly);
      const expected = expectedDigits(field.config, props.formValues);

      return (
        <div className="flex items-stretch">
          {editableCode ? (
            <div className="relative shrink-0">
              <select
                aria-label="Country code"
                className="input w-[5.75rem] appearance-none rounded-r-none border-r-0 pl-2.5 pr-6 text-sm tnum"
                value={code}
                onChange={(e) => {
                  const next = e.target.value;
                  props.onChangeOther!(codeField, next);
                  // Re-clip the number to the new country's length, otherwise
                  // switching India → Singapore leaves ten digits in a field
                  // the API will reject for being two too long.
                  const limit = (field.config.digitsMap ?? {})[next] ?? 0;
                  const digits = String(value ?? '').replace(/\D/g, '');
                  if (limit && digits.length > limit) onChange(digits.slice(0, limit));
                }}
              >
                {codes.map((c) => <option key={c.value} value={c.value}>{c.value}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            </div>
          ) : code ? (
            <span className="flex shrink-0 items-center rounded-l-lg border border-r-0 border-slate-300 bg-slate-50 px-2.5 text-sm text-muted tnum dark:border-slate-700 dark:bg-slate-800">
              {code}
            </span>
          ) : null}
          <input
            id={id}
            type="tel"
            inputMode="numeric"
            className={cn(inputClass, 'tnum', (code || editableCode) && 'rounded-l-none')}
            value={String(value ?? '')}
            // Stripping non-digits on the way in rather than validating after
            // the fact: a pasted "+91 98765-43210" becomes the right ten digits
            // instead of an error the user has to work out how to fix.
            //
            // The code itself is dropped too, and only when dropping it leaves
            // exactly a full number. Somebody handed a number reads it out with
            // its code — the whole point of a fixed prefix is that they never
            // have to think about that — and clipping to ten digits first kept
            // the wrong end of it: "+91 98115 33636" became 9198115336. A real
            // ten-digit number that happens to start 91 is untouched, because
            // taking the code off it would leave eight digits, not ten.
            onChange={(e) => {
              let digits = e.target.value.replace(/\D/g, '');
              const bare = code.replace(/\D/g, '');
              const overLength = expected ? digits.length > expected : true;
              // Something has to be left that could be a real subscriber
              // number, or "+91" typed on its own eats itself.
              const remainder = digits.length - bare.length;
              if (bare && overLength && digits.startsWith(bare) && remainder >= 6
                && (!expected || remainder <= expected)) {
                digits = digits.slice(bare.length);
              }
              onChange((expected ? digits.slice(0, expected) : digits) || null);
            }}
            disabled={readOnly}
            // One over the limit, so a number typed or pasted with its country
            // code in front still reaches the handler that takes the code off.
            maxLength={expected ? expected + String(code).replace(/\D/g, '').length : undefined}
            placeholder={expected ? '9'.repeat(Math.min(expected, 10)) : '98765 43210'}
            autoFocus={autoFocus}
          />
        </div>
      );
    }

    case 'url':
      return (
        <input
          id={id}
          type="url" className={inputClass} value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value || null)} disabled={readOnly}
          placeholder="https://" autoFocus={autoFocus}
        />
      );

    case 'json':
      return (
        <textarea
          className={cn(inputClass, 'font-mono text-xs')}
          rows={4}
          value={typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)}
          onChange={(e) => {
            try { onChange(JSON.parse(e.target.value)); } catch { onChange(e.target.value); }
          }}
          disabled={readOnly}
        />
      );

    case 'image':
      return <GalleryField {...props} readOnly={readOnly} />;

    case 'autonumber':
    case 'formula':
    case 'rollup':
      return (
        <input
          className={cn(inputClass, 'bg-slate-50 text-slate-500 dark:bg-slate-800')}
          value={value ? String(value) : 'Generated automatically'}
          disabled
        />
      );

    default:
      return (
        <input
          id={id}
          className={inputClass}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={readOnly}
          maxLength={field.maxLength ?? undefined}
          placeholder={field.config.placeholder as string}
          autoFocus={autoFocus}
        />
      );
  }
}


function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Area — a number with its unit welded to the right
//
// An area without its unit is not a number anyone can act on: 1,200 is a
// generous flat in sq.ft and a plot in sq.yd. Asking for the unit as its own
// form row invites people to skip it, so it lives inside the control, the way
// every property portal presents it. The unit is still an ordinary field
// (`config.unitField`), so it reports, filters and imports like one.
// ---------------------------------------------------------------------------

function AreaInput({
  field, value, onChange, onChangeOther, formValues, readOnly, className, id,
}: FieldInputProps & { readOnly: boolean; className: string }): JSX.Element {
  const unitField = String(field.config.unitField);
  const options = field.config.unitOptions ?? [
    { value: 'sqft', label: 'Sq.ft.' },
    { value: 'sqyd', label: 'Sq.yd.' },
  ];
  const unit = String(formValues?.[unitField] ?? field.config.unit ?? options[0]?.value ?? 'sqft');

  return (
    <div className="flex items-stretch">
      <input
        id={id}
        type="number"
        min={0}
        step="any"
        className={cn(className, 'tnum rounded-r-none')}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        disabled={readOnly}
        placeholder="e.g. 1200"
      />
      <div className="relative shrink-0">
        <select
          aria-label={`${field.label} unit`}
          className="input w-[6.25rem] appearance-none rounded-l-none border-l-0 pl-2.5 pr-6 text-sm"
          value={unit}
          disabled={readOnly || !onChangeOther}
          onChange={(e) => onChangeOther?.(unitField, e.target.value)}
        >
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Currency — accepts "1.5 cr" and shows the parsed value. A currency field
// with `config.unitField` (budget, demand) additionally carries a unit
// selector welded to its right edge, exactly the shape the area control made.
// ---------------------------------------------------------------------------

function CurrencyInput({
  field, value, onChange, onChangeOther, formValues, readOnly, className, id,
}: FieldInputProps & { readOnly: boolean; className: string }): JSX.Element {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  const [focused, setFocused] = useState(false);

  const unitField = field.config.unitField ? String(field.config.unitField) : null;
  const unitOptions = (field.config.unitOptions as { value: string; label: string }[] | undefined) ?? null;
  const unit = unitField && unitOptions
    ? String(formValues?.[unitField] ?? unitOptions[0]?.value ?? '')
    : null;

  useEffect(() => {
    if (!focused) setText(value === null || value === undefined ? '' : String(value));
  }, [value, focused]);

  const parse = (raw: string): number | null => {
    const cleaned = raw.replace(/[₹,\s]/gi, '').toLowerCase();
    if (!cleaned) return null;
    const m = cleaned.match(/^([\d.]+)\s*(cr|crore|l|lac|lakh|k)?$/);
    if (!m) return Number.isFinite(Number(cleaned)) ? Number(cleaned) : null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    switch (m[2]) {
      case 'cr': case 'crore': return n * 1e7;
      case 'l': case 'lac': case 'lakh': return n * 1e5;
      case 'k': return n * 1000;
      default: return n;
    }
  };

  const amount = (
    <div className={cn('relative', unitField && 'min-w-0 flex-1')}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">₹</span>
      <input
        id={id}
        className={cn(className, 'pl-7 tnum', unitField && 'rounded-r-none')}
        value={focused ? text : (value ? formatIndianPrice(Number(value)).replace('₹', '') : '')}
        onFocus={() => { setFocused(true); setText(value ? String(value) : ''); }}
        onBlur={() => { setFocused(false); onChange(parse(text)); }}
        onChange={(e) => setText(e.target.value)}
        disabled={readOnly}
        placeholder="e.g. 1.5 Cr or 12500000"
      />
      {focused && text && parse(text) !== null && (
        <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 text-2xs text-muted sm:block">
          {formatIndianPrice(parse(text)!)}
        </span>
      )}
    </div>
  );

  if (!unitField || !unitOptions) return amount;

  return (
    <div className="flex items-stretch">
      {amount}
      <div className="relative shrink-0">
        <select
          aria-label={`${field.label} unit`}
          className="input w-[6.75rem] appearance-none rounded-l-none border-l-0 pl-2.5 pr-6 text-sm"
          value={unit ?? ''}
          disabled={readOnly || !onChangeOther}
          onChange={(e) => onChangeOther?.(unitField, e.target.value)}
        >
          {unitOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gallery — the 'image' uitype. config.multiple: true (a property's
// gallery fields) stores an array of /api/files/:id URLs and accepts several
// photos/videos at once (the plain <input accept="image/*,video/*" multiple>
// is what makes iOS Safari offer "Take Photo or Video / Photo Library" —
// no capture attribute, which would restrict to camera-only). A single
// F.image() field (e.g. an org logo) is the same component with one slot.
// Uploads go through the existing api.uploadFile → POST /api/files, which
// now also enqueues async derivative generation (see core/media/pipeline.ts
// server-side) — this component never waits on that, it just shows the
// original immediately and the thumbnail swaps in once ready on next load.
// ---------------------------------------------------------------------------

function GalleryField({
  field, value, onChange, readOnly, recordId, moduleName,
}: FieldInputProps & { readOnly: boolean }): JSX.Element {
  const multiple = Boolean(field.config.multiple);
  const urls = useMemo<string[]>(() => {
    if (multiple) return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    return typeof value === 'string' && value ? [value] : [];
  }, [value, multiple]);

  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    setUploading({ done: 0, total: files.length });

    const uploaded: string[] = [];
    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker() {
      while (cursor < files.length) {
        const file = files[cursor++];
        try {
          const res = await api.uploadFile(file, recordId, moduleName);
          uploaded.push(res.url);
        } catch {
          toast.error(`Failed to upload ${file.name}`);
        } finally {
          setUploading((s) => (s ? { ...s, done: s.done + 1 } : s));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

    setUploading(null);
    if (!uploaded.length) return;
    onChange(multiple ? [...urls, ...uploaded] : uploaded[uploaded.length - 1]);
  }

  function remove(url: string) {
    onChange(multiple ? urls.filter((u) => u !== url) : null);
    const id = url.split('/').pop();
    if (id) api.deleteFile(id).catch(() => undefined); // best-effort; the field value is the source of truth either way
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {urls.map((url) => (
          <GalleryThumb key={url} url={url} onRemove={readOnly ? undefined : () => remove(url)} />
        ))}

        {!readOnly && (multiple || urls.length === 0) && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={Boolean(uploading)}
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-slate-300 text-slate-400 hover:border-brand-400 hover:text-brand-500 disabled:opacity-60 dark:border-slate-700"
          >
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
            <span className="text-2xs">
              {uploading ? `${uploading.done}/${uploading.total}` : 'Add'}
            </span>
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple={multiple}
        className="hidden"
        onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}

function GalleryThumb({ url, onRemove }: { url: string; onRemove?: () => void }): JSX.Element {
  const [isVideo, setIsVideo] = useState(false);
  return (
    <div className="group relative h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
      {isVideo ? (
        <div className="flex h-full w-full items-center justify-center text-slate-400">
          <Video size={22} />
        </div>
      ) : (
        <img
          src={authedImageUrl(url, 'thumb')}
          alt=""
          className="h-full w-full object-cover"
          onError={(e) => {
            // Not an image (a video attachment) or no derivative yet — the
            // <img> tag can't render video, so fall back to a plain icon
            // rather than a broken-image glyph.
            if ((e.target as HTMLImageElement).src.includes('size=thumb')) {
              (e.target as HTMLImageElement).src = authedImageUrl(url); // retry the original
            } else {
              setIsVideo(true);
            }
          }}
        />
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

export function MultiSelect({
  options, value, onChange, disabled,
}: {
  options: { value: string; label: string; color: string | null }[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const filtered = options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()));

  const toggle = (v: string): void => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };

  return (
    <div className="relative" ref={ref}>
      <div
        className={cn('input flex min-h-[2.375rem] flex-wrap items-center gap-1 py-1.5', disabled && 'bg-slate-50 dark:bg-slate-800')}
        onClick={() => !disabled && setOpen(true)}
      >
        {value.length === 0 && <span className="text-muted">— Select —</span>}
        {value.map((v) => {
          const o = options.find((x) => x.value === v);
          return (
            <Badge key={v} color={o?.color}>
              {o?.label ?? v}
              {!disabled && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggle(v); }}
                  className="ml-0.5 opacity-60 hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </Badge>
          );
        })}
      </div>

      {open && !disabled && (
        <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-float dark:border-slate-700 dark:bg-slate-900">
          <div className="sticky top-0 border-b border-slate-100 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
            <input
              className="input py-1 text-xs"
              placeholder="Search…"
              value={search}
              autoFocus
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle(o.value)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <span className={cn(
                'flex h-4 w-4 items-center justify-center rounded border',
                value.includes(o.value) ? 'border-brand-600 bg-brand-600' : 'border-slate-300 dark:border-slate-600',
              )}>
                {value.includes(o.value) && <Check className="h-3 w-3 text-white" />}
              </span>
              {o.label}
            </button>
          ))}
          {filtered.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted">No matches</p>}
          {/* Same place as every other dropdown's Clear. Taking six chips off
              one at a time is the alternative. */}
          {value.length > 0 && (
            <div className="sticky bottom-0 border-t border-slate-100 bg-white dark:border-slate-800 dark:bg-slate-900">
              <button
                type="button"
                onClick={() => onChange([])}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-slate-300 dark:border-slate-600" />
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TagInput({
  value, onChange, disabled,
}: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }): JSX.Element {
  const [text, setText] = useState('');
  return (
    <div className={cn('input flex min-h-[2.375rem] flex-wrap items-center gap-1 py-1.5', disabled && 'bg-slate-50')}>
      {value.map((tag) => (
        <Badge key={tag}>
          {tag}
          {!disabled && (
            <button type="button" onClick={() => onChange(value.filter((t) => t !== tag))} className="ml-0.5 opacity-60 hover:opacity-100">
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </Badge>
      ))}
      {!disabled && (
        <input
          className="min-w-[6rem] flex-1 border-0 bg-transparent p-0 text-sm outline-none placeholder:text-muted"
          placeholder={value.length ? '' : 'Add tags…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && text.trim()) {
              e.preventDefault();
              const tag = text.trim().toLowerCase();
              if (!value.includes(tag)) onChange([...value, tag]);
              setText('');
            } else if (e.key === 'Backspace' && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reference picker — searches the target module live
// ---------------------------------------------------------------------------

export function ReferencePicker({
  field, value, onChange, disabled, error, placeholder, autoOpen, onOpenChange,
}: {
  field: FieldMeta;
  value: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  error?: string;
  placeholder?: string;
  /** open the search dropdown immediately, e.g. when a click already triggered entering edit mode */
  autoOpen?: boolean;
  /** told whenever the dropdown opens/closes, so a caller driving edit-mode from the outside can stay in sync */
  onOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const modules = (field.config.referenceModules as string[]) ?? [];
  const [module, setModule] = useState(modules[0] ?? '');
  const [open, setOpenState] = useState(Boolean(autoOpen));
  const setOpen = (next: boolean | ((v: boolean) => boolean)): void => {
    setOpenState((prev) => {
      const value_ = typeof next === 'function' ? next(prev) : next;
      onOpenChange?.(value_);
      return value_;
    });
  };
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<{ id: string; label: string; recordNumber: string | null }[]>([]);
  const [selectedLabel, setSelectedLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Resolve the label for an already-set value.
  useEffect(() => {
    if (!value) { setSelectedLabel(''); return; }
    let cancelled = false;
    void (async () => {
      for (const m of modules) {
        try {
          const record = await api.record(m, value);
          if (!cancelled) { setSelectedLabel(record.label); setModule(m); }
          return;
        } catch { /* try the next candidate module */ }
      }
    })();
    return () => { cancelled = true; };
  }, [value, modules.join(',')]);

  useEffect(() => {
    if (!open || !module) return;
    setLoading(true);
    const timer = setTimeout(() => {
      void api.lookup(module, search)
        .then((r) => setResults(r))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 220);
    return () => clearTimeout(timer);
  }, [open, search, module]);

  return (
    <div className="relative" ref={ref}>
      <div
        className={cn(
          'input flex cursor-pointer items-center gap-2',
          error && 'border-red-400',
          disabled && 'cursor-not-allowed bg-slate-50 dark:bg-slate-800',
        )}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className={cn('flex-1 truncate', !selectedLabel && 'text-muted')}>
          {selectedLabel || placeholder || '— Select —'}
        </span>
        {value && !disabled && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange(null); setSelectedLabel(''); }}
            className="text-slate-400 hover:text-slate-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && !disabled && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-float dark:border-slate-700 dark:bg-slate-900">
          {modules.length > 1 && (
            <div className="flex gap-1 border-b border-slate-100 p-1.5 dark:border-slate-800">
              {modules.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModule(m)}
                  className={cn(
                    'rounded px-2 py-0.5 text-2xs font-medium capitalize',
                    module === m ? 'bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
                  )}
                >
                  {m.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          )}
          <div className="border-b border-slate-100 p-2 dark:border-slate-800">
            <input
              className="input py-1 text-xs"
              placeholder="Type to search…"
              value={search}
              autoFocus
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {loading && <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-slate-400" /></div>}
            {!loading && results.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted">No records found</p>
            )}
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => { onChange(r.id); setSelectedLabel(r.label); setOpen(false); setSearch(''); }}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <span className="truncate">{r.label}</span>
                {r.recordNumber && <span className="shrink-0 font-mono text-2xs text-muted">{r.recordNumber}</span>}
              </button>
            ))}
          </div>
          {/* Where every other dropdown keeps Clear. The × on the closed
              control only appears once something is chosen and is easy to
              miss besides. */}
          {value && (
            <>
              <div className="border-t border-slate-100 dark:border-slate-800" />
              <button
                type="button"
                onClick={() => { onChange(null); setSelectedLabel(''); setOpen(false); setSearch(''); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-slate-300 dark:border-slate-600" />
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// User / owner picker
// ---------------------------------------------------------------------------

export function UserPicker({
  value, onChange, disabled, id, label,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  id?: string;
  /** Fallback accessible name when no <label htmlFor> points at this select. */
  label?: string;
}): JSX.Element {
  const [users, setUsers] = useState<{ id: string; fullName: string }[]>([]);

  useEffect(() => {
    void api.users().then((rows) => setUsers(rows as never)).catch(() => undefined);
  }, []);

  const selected = users.find((u) => u.id === value);
  const selectedName = selected ? selected.fullName : '';

  return (
    <div className="relative">
      <select
        id={id}
        aria-label={id ? undefined : (label ?? 'Owner')}
        /*
          The left padding is a class, not a <style> tag.

          This used to render `<style>{'select { padding-left: 2rem; }'}</style>`
          whenever somebody was selected. Two things wrong with it, and the
          visible one had been shipped for months: `.input` sets `px-3` and a
          class beats a bare element selector, so the rule never applied and the
          avatar sat on top of the first two letters of the name — "Rishabh
          Singhla" read as "RSshabh Singhla" on every form in the CRM. The
          quieter one is that the tag is not scoped to this component at all, so
          a mounted owner field was restyling every other <select> on the page.
        */
        className={cn('input appearance-none pr-8', selectedName && 'pl-9')}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {/*
          There is no "Unassigned" to pick.

          A record in this CRM belongs to somebody — a new one starts on
          whoever is adding it, and handing it on means naming the next person,
          not emptying the box. Offering "Unassigned" made losing a record a
          one-click mistake with nothing to notice it by.

          The blank option stays only while the value *is* blank, disabled, so
          an older record that was saved without an assignee still reads
          honestly instead of silently showing whoever happens to sort first.
          Once somebody is chosen there is no way back to empty.
        */}
        {!value && <option value="" disabled>— Select —</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.fullName}</option>
        ))}
      </select>
      {selectedName && (
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
          <Avatar name={selectedName} size={20} />
        </span>
      )}
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

function AddressInput({
  value, onChange, disabled,
}: { value: Record<string, unknown> | null; onChange: (v: unknown) => void; disabled?: boolean }): JSX.Element {
  const a = value ?? {};
  const set = (key: string, v: string): void => onChange({ ...a, [key]: v });

  return (
    <div className="grid grid-cols-2 gap-2">
      <input
        className="input col-span-2" placeholder="Street / building"
        value={String(a.street ?? '')} onChange={(e) => set('street', e.target.value)} disabled={disabled}
      />
      <input
        className="input" placeholder="Locality"
        value={String(a.locality ?? '')} onChange={(e) => set('locality', e.target.value)} disabled={disabled}
      />
      <input
        className="input" placeholder="City"
        value={String(a.city ?? '')} onChange={(e) => set('city', e.target.value)} disabled={disabled}
      />
      <input
        className="input" placeholder="State"
        value={String(a.state ?? '')} onChange={(e) => set('state', e.target.value)} disabled={disabled}
      />
      <input
        className="input tnum" placeholder="Pincode"
        value={String(a.pincode ?? '')} onChange={(e) => set('pincode', e.target.value)} disabled={disabled}
      />
    </div>
  );
}
