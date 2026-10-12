/**
 * The form that opens beside an Associate's deal table for the row you picked.
 *
 * Every property has its own: what the dealer posted is filled in already, and the
 * rest — house number, portion, next follow-up, status, why it was lost, where it
 * came from — is typed in here, on the spot, with no Save button to remember.
 * Each box saves when you leave it.
 *
 * Which fields are on it is Admin -> Layouts (`associateDealFormFields`, plus any
 * the admin added). What is *not* on it is deliberate: Mobile, Assigned To,
 * Contact Type and Operating Location belong to the dealer, who is the record this
 * sits on, not to one of their properties.
 */
import { type JSX, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type DealerDeal, type DealerDealPatch } from '../lib/api';
import { DEAL_FORM_FIELDS, type CustomDealField, type DealFormField } from '../lib/dealGrid';

const BOX = 'h-8 w-full rounded-md border border-[var(--border)] bg-white px-2 text-xs outline-none focus:border-brand-500 dark:bg-slate-900';

/** An emptied box means "not known": null, never an empty string. */
const textOrNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
const numberOrNull = (value: string): number | null => (value.trim() === '' || Number.isNaN(Number(value)) ? null : Number(value));

/** A dropdown's values from an Admin -> Dropdowns master, keeping a value the master no longer lists so it is not silently lost on save. */
function useMaster(name: string, current: string | null): string[] {
  const { data } = useQuery({ queryKey: ['picklist', name], queryFn: () => api.picklist(name), staleTime: 5 * 60_000 });
  const values = (data ?? []).filter((item) => item.isActive !== false).map((item) => item.value);
  return current && !values.includes(current) ? [current, ...values] : values;
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="block">
      <span className="key-label mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function MasterSelect({ master, value, onSave, label }: { master: string; value: string | null; onSave: (value: string | null) => void; label: string }): JSX.Element {
  const options = useMaster(master, value);
  return (
    <select aria-label={label} className={BOX} value={value ?? ''} onChange={(event) => onSave(textOrNull(event.target.value))}>
      <option value="">—</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

export default function DealDetailForm({ deal, fields, customFields, saving, onSave, onClose }: {
  deal: DealerDeal;
  fields: DealFormField[];
  customFields: CustomDealField[];
  saving: boolean;
  onSave: (patch: DealerDealPatch) => void;
  onClose: () => void;
}): JSX.Element {
  // Local copies of the typed boxes, so typing is never fought by the list refetching under it.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const shown = (key: string, saved: string | number | null | undefined): string => draft[key] ?? (saved === null || saved === undefined ? '' : String(saved));
  const typing = (key: string) => (event: { target: { value: string } }): void => setDraft((current) => ({ ...current, [key]: event.target.value }));

  /**
   * Saves a typed box only if it changed. The typed text stays on screen until the
   * row is closed, so the box never snaps back to the old value while the save is
   * on its way — and typing the same thing twice saves once, because the second
   * time it already equals what was saved.
   */
  const leave = (key: string, saved: string | number | null | undefined, patch: (value: string) => DealerDealPatch) => (): void => {
    const typed = draft[key];
    if (typed === undefined) return;
    if (typed.trim() === (saved === null || saved === undefined ? '' : String(saved))) return;
    onSave(patch(typed));
  };

  const text = (key: string, label: string, saved: string | null, patch: (value: string | null) => DealerDealPatch, type = 'text'): JSX.Element => (
    <Field label={label}>
      <input className={BOX} type={type} value={shown(key, saved)} onChange={typing(key)} onBlur={leave(key, saved, (value) => patch(textOrNull(value)))} aria-label={label} />
    </Field>
  );
  const numeric = (key: string, label: string, saved: number | null, patch: (value: number | null) => DealerDealPatch): JSX.Element => (
    <Field label={label}>
      <input className={BOX} type="number" min={0} step="any" value={shown(key, saved)} onChange={typing(key)} onBlur={leave(key, saved, (value) => patch(numberOrNull(value)))} aria-label={label} />
    </Field>
  );

  const labelOf = (key: DealFormField): string => DEAL_FORM_FIELDS.find((field) => field.key === key)!.label;
  const control: Record<DealFormField, () => JSX.Element> = {
    deal_type: () => (
      <Field label={labelOf('deal_type')}>
        <select aria-label={labelOf('deal_type')} className={BOX} value={deal.purpose} onChange={(event) => onSave({ purpose: event.target.value as 'sale' | 'rent' })}>
          <option value="sale">For Sale</option>
          <option value="rent">For Rent</option>
        </select>
      </Field>
    ),
    house_no: () => text('house_no', labelOf('house_no'), deal.houseNo, (value) => ({ houseNo: value })),
    locality: () => text('locality', labelOf('locality'), deal.places.join(', ') || null, (value) => ({ locality: value })),
    price: () => numeric('price', labelOf('price'), deal.priceMinLakh, (value) => ({ priceLakh: value })),
    size: () => numeric('size', labelOf('size'), deal.sizeSqYd, (value) => ({ sizeSqYd: value })),
    bedrooms: () => numeric('bedrooms', labelOf('bedrooms'), deal.bhk, (value) => ({ bedrooms: value === null ? null : Math.round(value) })),
    category: () => text('category', labelOf('category'), deal.category, (value) => ({ category: value })),
    facing: () => text('facing', labelOf('facing'), deal.facing, (value) => ({ facing: value })),
    floor: () => text('floor', labelOf('floor'), deal.floor, (value) => ({ floor: value })),
    portion: () => text('portion', labelOf('portion'), deal.portion, (value) => ({ portion: value })),
    next_followup: () => text('next_followup', labelOf('next_followup'), deal.nextFollowUpAt, (value) => ({ nextFollowUpAt: value }), 'date'),
    property_status: () => (
      <Field label={labelOf('property_status')}>
        <MasterSelect master="property_status" label={labelOf('property_status')} value={deal.propertyStatus} onSave={(value) => onSave({ propertyStatus: value })} />
      </Field>
    ),
    lost_reason: () => (
      <Field label={labelOf('lost_reason')}>
        <MasterSelect master="lost_reason" label={labelOf('lost_reason')} value={deal.lostReason} onSave={(value) => onSave({ lostReason: value })} />
      </Field>
    ),
    source: () => (
      <Field label={labelOf('source')}>
        <MasterSelect master="lead_source" label={labelOf('source')} value={deal.source} onSave={(value) => onSave({ source: value })} />
      </Field>
    ),
  };

  const nothingToShow = fields.length === 0 && customFields.length === 0;

  return (
    <aside className="flex flex-col rounded-lg border border-[var(--border)] bg-white dark:bg-slate-900" data-testid="deal-form" aria-label="Property details">
      <header className="panel-head flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold">{deal.houseNo ? `${deal.houseNo} · ` : ''}{deal.summary || 'Property details'}</p>
          <p className="text-[11px] text-muted" data-testid="deal-form-state">{saving ? 'Saving…' : deal.stored ? 'Saved' : 'Fill in a box and it saves'}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close property details" title="Close" className="rounded-md p-1 text-muted hover:bg-[var(--surface-muted)]"><X className="h-4 w-4" /></button>
      </header>
      <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-1">
        {nothingToShow && <p className="text-xs text-muted sm:col-span-2 xl:col-span-1">This form has no fields. Choose some in Admin → Layouts → Associates.</p>}
        {fields.map((key) => <div key={key}>{control[key]()}</div>)}
        {customFields.map((field) => (
          <div key={field.key}>
            {text(`extra_${field.key}`, field.label, deal.extra[field.key] ?? null, (value) => ({ extra: { [field.key]: value } }))}
          </div>
        ))}
      </div>
    </aside>
  );
}
