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
 *
 * The page opens as a list, not a form. Each group is one quiet row — what it
 * is called, one line on what it is for, and a peek at two or three of the
 * values it currently holds — and clicking opens just that group inline.
 * "Your business" starts open, because it is filled in once; the groups a
 * desk opens once a year sit under an "Advanced settings" divider. A search
 * opens everything it matches, so nothing is harder to find than before,
 * merely quieter until wanted.
 */
import { type JSX, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, RotateCcw, Save, Search, SlidersHorizontal } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { EmptyState, Skeleton, Spinner, Toggle } from '../../components/ui';

interface Setting {
  key: string; value: unknown; category: string;
  label: string | null; description: string | null; is_secret: boolean;
}

/** One row on the page: a category of settings with the rows in it. */
interface Group { id: string; title: string; blurb: string; rows: Setting[] }

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
  { id: 'telephony', title: 'Calls', blurb: 'Call recording.' },
  { id: 'ai', title: 'AI', blurb: 'Which parts of the CRM the AI is allowed to do on its own.' },
  {
    id: 'ai_features',
    title: 'AI features',
    blurb: 'One switch each. Every one of these can be off and the CRM still works, so nothing here is load-bearing.',
  },
  {
    id: 'ai_models',
    title: 'AI models',
    blurb: 'Which model does which job. Each box offers the models that can actually do that job, free ones first, '
      + 'with what the rest cost. Press Test to make a real call before you save. A blank or mistyped box falls '
      + 'back to the one the CRM shipped with rather than switching the feature off.',
  },
  {
    id: 'team_location',
    title: 'Where the team is',
    blurb: 'Off until you switch it on. When on, the companion app on each phone sends its position during '
      + 'the hours below, and Admin → Team map shows it. Tell your team before you turn this on: it is their '
      + 'personal data, and India\u2019s DPDP Act treats it that way.',
  },
  {
    id: 'house_style',
    title: 'How you sound',
    blurb: 'The voice behind every caption, description and voiceover. Change a box here and every listing in the '
      + 'business changes with it.',
  },
];

/**
 * Groups a desk opens once a year, if ever: the scoring numbers, what the AI
 * may do on its own, the WhatsApp and call rules, and tracking the team's
 * phones. They stay on this page — nothing has been taken away — but they
 * render under the "Advanced settings" divider, below the groups a desk
 * actually lives in.
 *
 * A category added to the settings table after this screen was written shows
 * above the divider, where a brand-new setting cannot be missed.
 */
const ADVANCED = new Set(['scoring', 'whatsapp', 'telephony', 'ai', 'ai_features', 'ai_models', 'team_location']);

/** Filled in once, then left alone: the one group that starts open. */
const STARTS_OPEN = ''; // nothing open on arrival — the list IS the page

export default function SettingsAdmin(): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.settings() });
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [query, setQuery] = useState('');
  /*
    Fourteen groups drawn open at once is a page you land on and scroll, and
    the feedback on it was that it felt heavy before you had read a word. So
    the page opens as a list: every group is one row — its title, a line on
    what it is for, a peek at what it currently holds — and only "Your
    business", which is filled in once and then left alone, starts open.

    Everything starts shut, including Your business: the page must read as a
    list of headings, not a wall of forms (e2e/adminSettings.spec.ts pins
    that). A search opens whatever it matched, and a group the admin has
    explicitly shut stays shut.
  */
  const [opened, setOpened] = useState<Record<string, boolean>>({});

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

  // Everyday groups above the line, the once-a-year ones under it. The split
  // is presentation only: both halves render the same rows, the same way.
  const everyday = grouped.filter((g) => !ADVANCED.has(g.id));
  const advanced = grouped.filter((g) => ADVANCED.has(g.id));

  const renderGroup = (g: Group): JSX.Element => {
    // A search opens what it found; otherwise the admin's own choice wins,
    // and "Your business" starts open because it is filled in once.
    const isOpen = q ? true : (opened[g.id] ?? g.id === STARTS_OPEN);
    const changedHere = g.rows.filter((s) => s.key in draft).length;

    return (
      <GroupCard
        key={g.id}
        group={g}
        peek={peekLine(g.id, g.rows, draft)}
        open={isOpen}
        changed={changedHere}
        onToggle={() => setOpened((o) => ({ ...o, [g.id]: !isOpen }))}
      >
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
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
      </GroupCard>
    );
  };

  if (isLoading) {
    return <div className="space-y-3 p-6">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 pb-24">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
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

      {everyday.length > 0 && <div className="space-y-3">{everyday.map(renderGroup)}</div>}

      {advanced.length > 0 && (
        <section aria-label="Advanced settings">
          <div className="flex items-center gap-3" role="separator">
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
            <span className="shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted">Advanced settings</span>
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          </div>
          <p className="mt-1.5 text-center text-xs text-muted">
            The numbers and switches most desks never open. Leave these alone and the CRM works as it should.
          </p>
          <div className="mt-4 space-y-3">{advanced.map(renderGroup)}</div>
        </section>
      )}

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

// ---------------------------------------------------------------------------
// The peek on a closed group
//
// Two or three of the values the group currently holds, in plain words, so
// the list answers "what is set here?" without being opened. It is read-only
// rendering of the same values the rows show; anything missing or too
// structured to summarise is simply left out of the line.
// ---------------------------------------------------------------------------

/** One "Label: value" phrase on a closed group's row. */
interface PeekPair { label: string; value: string }

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A switch that is off is information too, so booleans read as words. */
const onOff = (v: unknown): string | null => (typeof v === 'boolean' ? (v ? 'On' : 'Off') : null);

/** A phrase long enough to wrap the row is cut short rather than spilled. */
const glance = (v: unknown, max = 44): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const withDays = (v: unknown): string | null => (typeof v === 'number' ? `${v} days` : null);
const withHours = (v: unknown): string | null => (typeof v === 'number' ? `${v} hours` : null);
const withMinutes = (v: unknown): string | null => (typeof v === 'number' ? `${v} min` : null);

/** The day the desk is shut, when there is exactly one. */
const weekOff = (v: unknown): string | null => {
  const days = (v as { days?: unknown } | null)?.days;
  if (!Array.isArray(days) || days.length === 0) return null;
  const off = DAYS.filter((d) => !days.includes(d.n));
  return off.length === 1 ? DAY_NAMES[off[0].n] : null;
};

/** Opening hours as a shop door would write them. */
const hoursSpan = (v: unknown): string | null => {
  const h = (v ?? {}) as { start?: string; end?: string };
  return h.start && h.end ? `${h.start}–${h.end}` : null;
};

const keep = (pairs: (PeekPair | null)[]): PeekPair[] =>
  pairs.filter((p): p is PeekPair => p !== null);

/** Whatever a value says in one breath — for categories this screen was not written knowing. */
function plainValue(v: unknown): string | null {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'number') return String(v);
  if (isStringList(v)) return v.join(', ');
  if (typeof v === 'string') return glance(v);
  return null;
}

/**
 * Which of a group's values are worth a glance, and what to call them.
 *
 * Known groups get the two or three settings that describe the group's
 * current behaviour — the currency the documents carry, the day the desk is
 * shut, whether the AI may answer for itself. A category this screen was
 * not written knowing falls back to whatever its rows say plainly.
 */
function peekPairs(id: string, rows: Setting[], draft: Record<string, unknown>): PeekPair[] {
  // The draft when there is one, so a peek matches what reopening the group
  // would show — not the last thing that was saved.
  const current = (key: string): unknown => {
    const s = rows.find((r) => r.key === key);
    if (!s) return undefined;
    return s.key in draft ? draft[s.key] : s.value;
  };
  const pair = (label: string, v: unknown, fmt?: (x: unknown) => string | null): PeekPair | null => {
    const value = fmt ? fmt(v) : plainValue(v);
    return value ? { label, value } : null;
  };

  switch (id) {
    case 'general':
      return keep([
        pair('Currency', current('org.currency')),
        pair('Week off', current('business_hours'), weekOff),
        pair('Hours', current('business_hours'), hoursSpan),
      ]);
    case 'sales':
      return keep([
        pair('Auto-assign', current('leads.auto_assign')),
        pair('Duplicate window', current('leads.duplicate_window_days'), withDays),
      ]);
    case 'scoring':
      return keep([
        pair('Hot at', current('scoring.hot_at')),
        pair('Warm at', current('scoring.warm_at')),
        pair('Match floor', current('scoring.match_floor')),
      ]);
    case 'inventory':
      return keep([
        pair('Unit holds', current('inventory.default_hold_days'), withDays),
        pair('Overbooking', current('inventory.allow_overbooking')),
      ]);
    case 'website':
      return keep([pair('Visible statuses', current('website.public_statuses'))]);
    case 'sharing': {
      const link = (current('sharing.property_link') ?? null) as { visibleFields?: unknown; showPhotos?: unknown } | null;
      return keep([
        pair('Photos', link?.showPhotos, onOff),
        pair('Fields shown', link?.visibleFields, (x) => (Array.isArray(x) && x.length > 0 ? String(x.length) : null)),
      ]);
    }
    case 'whatsapp':
      return keep([pair('Reply window', current('whatsapp.session_window_hours'), withHours)]);
    case 'telephony':
      // Masking used to be summarised here. It was never read by anything, and
      // number visibility is now a field permission per profile — Roles &
      // Profiles → Field permissions → Owner only. Migration 099 has the why.
      return keep([
        pair('Recording', current('telephony.record_calls')),
      ]);
    case 'ai':
      return keep([
        pair('WhatsApp replies', current('ai.auto_reply_whatsapp')),
        pair('Call analysis', current('ai.call_analysis')),
        pair('Daily digest', current('ai.daily_digest')),
      ]);
    case 'ai_features': {
      // One switch each, so the honest glance is a count rather than nine Ons and Offs.
      const switches = rows.filter((r) => typeof r.value === 'boolean');
      if (!switches.length) return [];
      const on = switches.filter((r) => (r.key in draft ? draft[r.key] : r.value)).length;
      return [{ label: 'Switched on', value: `${on} of ${switches.length}` }];
    }
    case 'ai_models':
      return [{ label: 'Models set', value: String(rows.length) }];
    case 'team_location': {
      const enabled = current('team_location.enabled');
      const out = keep([pair('Tracking', enabled)]);
      if (enabled) {
        const every = pair('Every', current('team_location.every_minutes'), withMinutes);
        if (every) out.push(every);
      }
      return out;
    }
    case 'house_style':
      return keep([
        pair('Captions', current('house_style.caption_tone'), (x) => glance(x, 40)),
        pair('Voiceover', current('house_style.voice_language'), (x) => glance(x, 40)),
      ]);
    default:
      return rows
        .flatMap((s) => {
          const value = plainValue(s.key in draft ? draft[s.key] : s.value);
          return value ? [{ label: s.label ?? s.key, value }] : [];
        })
        .slice(0, 2);
  }
}

/** The peek as one muted line, or nothing when the group has nothing to say. */
function peekLine(id: string, rows: Setting[], draft: Record<string, unknown>): string | null {
  const pairs = peekPairs(id, rows, draft);
  return pairs.length ? pairs.map((p) => `${p.label}: ${p.value}`).join(' · ') : null;
}

/**
 * One group as one row.
 *
 * Shut, it answers three questions without being opened: what is this, what
 * is it for, and what does it currently say. Open, it is the group's own
 * form, exactly as it has always been.
 */
function GroupCard({ group, peek, open, changed, onToggle, children }: {
  group: Group; peek: string | null; open: boolean; changed: number;
  onToggle: () => void; children: ReactNode;
}): JSX.Element {
  return (
    <section className="card overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {group.title}
            {/* Unsaved work inside a shut group would otherwise be invisible. */}
            {changed > 0 && (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-2xs font-normal text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                {changed} changed
              </span>
            )}
          </span>
          {group.blurb && <span className="mt-0.5 block text-xs font-normal text-muted">{group.blurb}</span>}
          {/* Only on a shut row: when the group is open its values are right there below. */}
          {!open && peek && <span className="mt-1 block truncate text-2xs text-muted">{peek}</span>}
        </span>
        <span className="shrink-0 text-2xs text-muted tnum">{group.rows.length}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 pb-1 dark:border-slate-800">
          {children}
        </div>
      )}
    </section>
  );
}

function Row({ setting, value, changed, onChange, onReset }: {
  setting: Setting; value: unknown; changed: boolean;
  onChange: (v: unknown) => void; onReset: () => void;
}): JSX.Element {
  // A paragraph of house style, or a model id long enough to run off the end of
  // a 16rem box, both need the full width rather than a column on the right.
  const wide = isBusinessHours(setting) || isAddress(setting)
    || setting.category === 'house_style' || isModel(setting);

  /*
    A real <label for>, not a paragraph beside a box.

    Every one of these rows drew its name as a <p>, so the control next to it had
    no accessible name at all: a screen reader announced "edit text, blank", and
    clicking the words did not put the cursor in the box. It looked right and was
    not, which is most of why the page felt unfinished.

    The purpose-built controls below (business hours, the address grid) label
    their own inputs, so those get a plain heading instead of a label pointing at
    nothing.
  */
  // A Toggle already wraps itself in a <label> with its own aria-label, and a
  // label inside a label is invalid HTML, so those keep the plain heading too.
  const ownsItsLabel = wide || typeof setting.value === 'boolean';
  const controlId = `setting-${setting.key.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const Name = ownsItsLabel ? 'p' : 'label';

  return (
    <div className={cn('py-4', wide ? 'space-y-3' : 'flex items-start gap-6')}>
      <div className="min-w-0 flex-1">
        <Name
          {...(ownsItsLabel ? {} : { htmlFor: controlId })}
          className={cn('flex items-center gap-2 text-sm font-medium', !ownsItsLabel && 'cursor-pointer')}
        >
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
        </Name>
        {setting.description && <p className="mt-0.5 text-xs text-muted">{setting.description}</p>}
      </div>
      <div className={cn(wide ? '' : 'shrink-0')}>
        <Control setting={setting} value={value} onChange={onChange} id={ownsItsLabel ? undefined : controlId} />
      </div>
    </div>
  );
}

/**
 * A model id, and a button that finds out whether it answers.
 *
 * The test is a real call — the smallest version of the job the model is there
 * to do. A `/models` listing would say yes to an id that is retired, out of
 * quota, or simply cannot see a picture, and all three of those are how a
 * feature is discovered broken by a customer rather than by a button.
 *
 * It tests what is in the box, not what is saved, so an id can be checked
 * before committing to it.
 */
function ModelRow({ setting, value, onChange }: {
  setting: Setting; value: unknown; onChange: (v: unknown) => void;
}): JSX.Element {
  const [result, setResult] = useState<{ ok: boolean; message: string; ms?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const job = setting.key.replace(/^ai_models\./, '');
  const model = typeof value === 'string' ? value : '';

  /*
    What can actually do this job.

    This box used to say "paste a model id from openrouter.ai/models", so every
    id was typed in by hand — and four of the eight shipped defaults were wrong,
    in four different ways. A box that sends somebody somewhere else to find its
    value is how that happens.

    A datalist rather than a dropdown on purpose: the box stays free text. A
    suggestion list goes stale the day a model is retired, and being unable to
    type the id that works would be worse than being offered one that does not.
    Empty when the catalogue is unreachable, and then this is the plain text box
    it has always been.
  */
  const { data: catalogue } = useQuery({
    queryKey: ['ai-model-catalogue', job],
    queryFn: () => api.aiModelCatalogue(job),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const options = catalogue?.models ?? [];
  const listId = `models-${job}`;

  const test = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.testAiModel(job, model));
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="input min-w-0 flex-1 font-mono text-xs"
          value={model}
          spellCheck={false}
          list={options.length ? listId : undefined}
          onChange={(e) => { onChange(e.target.value); setResult(null); }}
          placeholder={options.length ? 'Start typing, or pick one' : 'paste a model id from openrouter.ai/models'}
        />
        {options.length > 0 && (
          <datalist id={listId}>
            {options.map((m) => (
              // Free ones sort first, and the price rides along in the label so
              // the choice between ₹0 and ₹900 a million is visible at the point
              // of choosing rather than on a bill later.
              <option key={m.id} value={m.id} label={`${m.name} · ${m.price}`} />
            ))}
          </datalist>
        )}
        <button className="btn-secondary btn-sm shrink-0" onClick={() => void test()} disabled={busy || !model.trim()}>
          {busy ? <Spinner /> : null} Test
        </button>
      </div>
      {!result && options.length > 0 && (
        <p className="text-2xs text-muted">
          {options.length} models can do this job
          {options.some((m) => m.free) ? `, ${options.filter((m) => m.free).length} of them free` : ''}.
        </p>
      )}
      {result && (
        <p className={cn(
          'text-xs',
          result.ok ? 'text-positive' : 'text-negative',
        )}>
          {result.ok ? '✓ ' : '✕ '}{result.message}
          {result.ms ? ` (${(result.ms / 1000).toFixed(1)}s)` : ''}
        </p>
      )}
    </div>
  );
}

const isBusinessHours = (s: Setting): boolean => s.key === 'business_hours';
const isModel = (s: Setting): boolean => s.category === 'ai_models';
const isAddress = (s: Setting): boolean => s.key === 'org.address';
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function Control({ setting, value, onChange, id }: {
  setting: Setting; value: unknown; onChange: (v: unknown) => void; id?: string;
}): JSX.Element {
  if (isBusinessHours(setting)) return <BusinessHours value={value} onChange={onChange} />;
  if (isAddress(setting)) return <Address value={value} onChange={onChange} />;
  if (isModel(setting)) return <ModelRow setting={setting} value={value} onChange={onChange} />;
  if (setting.category === 'house_style') {
    return (
      <textarea
        className="input w-full text-sm"
        rows={3}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (typeof setting.value === 'boolean') {
    return <Toggle checked={Boolean(value)} onChange={onChange} ariaLabel={setting.label ?? setting.key} />;
  }
  if (typeof setting.value === 'number') {
    return (
      <input
        id={id}
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
        id={id}
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
        id={id}
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
