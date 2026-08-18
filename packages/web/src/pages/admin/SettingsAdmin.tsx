/**
 * Every setting, editable, without anybody adding a screen for it.
 *
 * The settings table has carried a label and a description per row since it was
 * built, and until recently only `brand` had anywhere to show them — so a
 * setting could be seeded, read by the engine, and still be unreachable by the
 * person it was for. A value only an API call can change is not a customisable
 * product; it is a developer dependency with extra steps.
 *
 * This renders whatever is in the table. Add a row in a migration and it
 * appears — no React, no release. It shows the label and the description and
 * never the key: "A lead is Hot at", with a sentence under it, is something a
 * sales head decides; `scoring.hot_at` is something that makes them close the
 * tab.
 *
 * Three settings hold structured values and get purpose-built controls below.
 * Anything else structured is shown read-only rather than as JSON in a text
 * box, which would save the object back as a string and break what reads it.
 */
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Save, Search, SlidersHorizontal } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { EmptyState, Skeleton, Spinner, Toggle } from '../../components/ui';

interface Setting {
  key: string; value: unknown; category: string;
  label: string | null; description: string | null; is_secret: boolean;
}

/** Edited on their own screens; showing them twice invites them to disagree. */
const OWNED_ELSEWHERE = new Set(['brand', 'social', 'branding']);

/**
 * Order and naming, chosen so the things somebody actually opens this page for
 * are near the top. Alphabetical put "AI" first and "Lead scoring" seventh,
 * which is backwards for a sales desk.
 */
const GROUPS: { id: string; title: string; blurb: string }[] = [
  { id: 'general', title: 'Your business', blurb: 'Name, address, hours and currency. Used on documents, the website and anything the CRM sends.' },
  { id: 'sales', title: 'Leads', blurb: 'How new enquiries are handled the moment they arrive.' },
  { id: 'scoring', title: 'Lead scoring', blurb: 'The numbers behind Hot, Warm and Cold, and how closely a property must fit a buyer.' },
  { id: 'inventory', title: 'Inventory', blurb: 'Rules for holding and booking units.' },
  { id: 'website', title: 'Public website', blurb: 'What visitors to your site can see.' },
  { id: 'sharing', title: 'Share links', blurb: 'What a buyer sees when you send them a property.' },
  { id: 'whatsapp', title: 'WhatsApp', blurb: 'Messaging rules.' },
  { id: 'telephony', title: 'Calls', blurb: 'Recording and number masking.' },
  { id: 'ai', title: 'AI', blurb: 'Which parts of the CRM the AI is allowed to do on its own.' },
];

export default function SettingsAdmin(): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.settings() });
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [query, setQuery] = useState('');

  const settings = useMemo(
    () => ((data ?? []) as unknown as Setting[])
      .filter((s) => !s.is_secret && !OWNED_ELSEWHERE.has(s.category)),
    [data],
  );

  useEffect(() => { setDraft({}); }, [data]);

  const save = useMutation({
    mutationFn: () => api.saveSettings(draft),
    onSuccess: () => {
      toast.success('Saved', 'The change is live now, not after a restart.');
      setDraft({});
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: (e: Error) => toast.error('Could not save', e.message),
  });

  // Matched on what somebody can actually see. Searching the key would find
  // things by a name this screen deliberately never shows them.
  const q = query.trim().toLowerCase();
  const matches = (s: Setting): boolean => !q
    || (s.label ?? '').toLowerCase().includes(q)
    || (s.description ?? '').toLowerCase().includes(q)
    || (GROUPS.find((g) => g.id === s.category)?.title ?? '').toLowerCase().includes(q);

  const grouped = useMemo(() => {
    const known = new Set(GROUPS.map((g) => g.id));
    const extra = [...new Set(settings.map((s) => s.category))].filter((c) => !known.has(c));
    const order = [...GROUPS, ...extra.map((id) => ({ id, title: id, blurb: '' }))];
    return order
      .map((g) => ({ ...g, rows: settings.filter((s) => s.category === g.id && matches(s)) }))
      .filter((g) => g.rows.length);
  }, [settings, q]);

  const dirty = Object.keys(draft).length;

  if (isLoading) {
    return <div className="space-y-3 p-6">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 pb-24">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="mt-1 text-sm text-muted">
          The numbers and switches the CRM makes decisions with. Change one and it applies straight away.
        </p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="input pl-9"
          placeholder="Search settings…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {!grouped.length && (
        <EmptyState
          icon={<SlidersHorizontal className="h-8 w-8" />}
          title="Nothing matches"
          body={q ? `No setting mentions "${query}".` : 'Settings added to the CRM appear here automatically.'}
        />
      )}

      {grouped.map((g) => (
        <section key={g.id} className="card p-5">
          <h3 className="text-sm font-semibold">{g.title}</h3>
          {g.blurb && <p className="mt-0.5 text-xs text-muted">{g.blurb}</p>}
          <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
            {g.rows.map((s) => (
              <Row
                key={s.key}
                setting={s}
                changed={s.key in draft}
                value={s.key in draft ? draft[s.key] : s.value}
                onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))}
                onReset={() => setDraft((d) => {
                  const { [s.key]: _drop, ...rest } = d;
                  return rest;
                })}
              />
            ))}
          </div>
        </section>
      ))}

      {/* Follows the page rather than sitting at the top, because on a long
          screen the button belongs where the eyes are. Only appears when there
          is something to save, so it never nags. */}
      {dirty > 0 && (
        <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{dirty} unsaved change{dirty === 1 ? '' : 's'}</span>
          </p>
          <button className="btn-secondary btn-sm" onClick={() => setDraft({})} disabled={save.isPending}>
            Discard
          </button>
          <button className="btn-primary btn-sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ setting, value, changed, onChange, onReset }: {
  setting: Setting; value: unknown; changed: boolean;
  onChange: (v: unknown) => void; onReset: () => void;
}): JSX.Element {
  const wide = isBusinessHours(setting) || isAddress(setting);

  return (
    <div className={cn('py-4', wide ? 'space-y-3' : 'flex items-start gap-6')}>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {setting.label ?? setting.key}
          {changed && (
            <button
              onClick={onReset}
              title="Undo this change"
              className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-2xs font-normal text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            >
              <RotateCcw className="h-2.5 w-2.5" /> changed
            </button>
          )}
        </p>
        {setting.description && <p className="mt-0.5 text-xs text-muted">{setting.description}</p>}
      </div>
      <div className={cn(wide ? '' : 'shrink-0')}>
        <Control setting={setting} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

const isBusinessHours = (s: Setting): boolean => s.key === 'business_hours';
const isAddress = (s: Setting): boolean => s.key === 'org.address';
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function Control({ setting, value, onChange }: {
  setting: Setting; value: unknown; onChange: (v: unknown) => void;
}): JSX.Element {
  if (isBusinessHours(setting)) return <BusinessHours value={value} onChange={onChange} />;
  if (isAddress(setting)) return <Address value={value} onChange={onChange} />;

  if (typeof setting.value === 'boolean') {
    return <Toggle checked={Boolean(value)} onChange={onChange} />;
  }
  if (typeof setting.value === 'number') {
    return (
      <input
        type="number"
        className="input w-24 text-right tnum"
        value={value === null || value === undefined ? '' : String(value)}
        // Kept as a number: the server stores the JSON it is handed, and a
        // threshold saved as the string "70" compares as text.
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  }
  if (typeof setting.value === 'string') {
    return (
      <input
        type="text"
        className="input w-64"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (isStringList(setting.value)) {
    return (
      <input
        type="text"
        className="input w-72"
        placeholder="Available, Booked"
        value={isStringList(value) ? value.join(', ') : ''}
        onChange={(e) => onChange(e.target.value.split(',').map((v) => v.trim()).filter(Boolean))}
      />
    );
  }
  return (
    <div className="max-w-xs text-right">
      <p className="truncate font-mono text-2xs text-muted" title={JSON.stringify(value)}>
        {JSON.stringify(value)}
      </p>
      <p className="mt-0.5 text-2xs text-muted">Needs its own editor</p>
    </div>
  );
}

const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 0, label: 'Sun' },
];

/** Days as buttons and times as time pickers, rather than a line of JSON. */
function BusinessHours({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  const v = (value ?? {}) as { start?: string; end?: string; days?: number[]; timezone?: string };
  const days = Array.isArray(v.days) ? v.days : [];
  const set = (patch: Partial<typeof v>): void => onChange({ ...v, ...patch });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {DAYS.map((d) => {
          const on = days.includes(d.n);
          return (
            <button
              key={d.n}
              type="button"
              aria-pressed={on}
              onClick={() => set({ days: on ? days.filter((x) => x !== d.n) : [...days, d.n].sort() })}
              className={cn(
                'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                on
                  ? 'border-brand-300 bg-brand-50 font-medium text-brand-700 dark:border-brand-700 dark:bg-brand-950 dark:text-brand-300'
                  : 'border-slate-200 text-muted hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
              )}
            >
              {d.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted">from</span>
        <input type="time" className="input w-32" value={v.start ?? ''} onChange={(e) => set({ start: e.target.value })} />
        <span className="text-muted">to</span>
        <input type="time" className="input w-32" value={v.end ?? ''} onChange={(e) => set({ end: e.target.value })} />
      </div>
    </div>
  );
}

const ADDRESS_FIELDS: { key: string; label: string }[] = [
  { key: 'street', label: 'Street' },
  { key: 'locality', label: 'Locality' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'pincode', label: 'PIN code' },
  { key: 'country', label: 'Country' },
];

function Address({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  const v = (value ?? {}) as Record<string, string>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {ADDRESS_FIELDS.map((f) => (
        <label key={f.key} className="block">
          <span className="text-2xs text-muted">{f.label}</span>
          <input
            className="input mt-0.5"
            value={v[f.key] ?? ''}
            // Spread first so any key this form does not know about — something
            // added later, or by another screen — survives an edit here.
            onChange={(e) => onChange({ ...v, [f.key]: e.target.value })}
          />
        </label>
      ))}
    </div>
  );
}
