/**
 * Every setting, editable, without anybody adding a screen for it.
 *
 * The settings table has carried a label and a description per row since it was
 * built, and until now only the `brand` category had anywhere to show them. So
 * a setting could exist, be seeded, be read by the engine, and still be
 * unreachable by the person it was for. A value only an API call can change is
 * not a customisable product; it is a developer dependency with extra steps.
 *
 * This renders whatever is in the table, grouped and typed from the stored
 * value. Add a row in a migration and it appears here — no React, no release.
 *
 * Deliberately shows the label and the description and never the key. `Hot at`
 * with a sentence under it is a thing a sales head can decide. `scoring.hot_at`
 * is a thing that makes them close the tab.
 */
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, SlidersHorizontal } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { EmptyState, Skeleton, Spinner, Toggle } from '../../components/ui';

interface Setting {
  key: string; value: unknown; category: string;
  label: string | null; description: string | null; is_secret: boolean;
}

/** Categories the CRM edits elsewhere, so they are not duplicated here. */
const OWNED_ELSEWHERE = new Set(['brand', 'social']);

/** A flat list of strings is editable as text; a list of objects is not. */
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const CATEGORY_TITLES: Record<string, string> = {
  scoring: 'Lead scoring',
  ai: 'AI',
  whatsapp: 'WhatsApp',
  telephony: 'Calls',
  general: 'General',
  branding: 'Branding',
  security: 'Security',
  storage: 'Storage',
  website: 'Public website',
};

export default function SettingsAdmin(): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.settings() });

  const settings = useMemo(
    () => ((data ?? []) as unknown as Setting[])
      .filter((s) => !s.is_secret && !OWNED_ELSEWHERE.has(s.category)),
    [data],
  );

  // Edits are held until Save so somebody can change three numbers that only
  // make sense together without the first one being rejected on its own.
  const [draft, setDraft] = useState<Record<string, unknown>>({});
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

  const grouped = useMemo(() => {
    const map = new Map<string, Setting[]>();
    for (const s of settings) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [settings]);

  const dirty = Object.keys(draft).length;

  if (isLoading) {
    return <div className="space-y-3 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>;
  }
  if (!settings.length) {
    return (
      <EmptyState
        icon={<SlidersHorizontal className="h-8 w-8" />}
        title="No settings yet"
        body="Settings added to the CRM appear here automatically."
      />
    );
  }

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Settings</h2>
          <p className="mt-1 text-sm text-muted">
            The numbers and switches the CRM makes decisions with. Change one and it applies straight away.
          </p>
        </div>
        <button
          className="btn-primary shrink-0"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Spinner /> : <Save className="h-3.5 w-3.5" />}
          {dirty ? `Save ${dirty} change${dirty === 1 ? '' : 's'}` : 'Saved'}
        </button>
      </div>

      {grouped.map(([category, rows]) => (
        <section key={category} className="card p-4">
          <h3 className="text-sm font-semibold">{CATEGORY_TITLES[category] ?? category}</h3>
          <div className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((s) => (
              <Row
                key={s.key}
                setting={s}
                value={s.key in draft ? draft[s.key] : s.value}
                onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The control is chosen from the stored value's type rather than from a
 * per-setting registry, which is what keeps this screen free for new settings.
 */
function Row({ setting, value, onChange }: {
  setting: Setting; value: unknown; onChange: (v: unknown) => void;
}): JSX.Element {
  const name = setting.label ?? setting.key;

  return (
    <div className="flex items-start gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{name}</p>
        {setting.description && <p className="mt-0.5 text-xs text-muted">{setting.description}</p>}
      </div>

      <div className="shrink-0">
        {typeof setting.value === 'boolean' ? (
          <Toggle checked={Boolean(value)} onChange={onChange} />
        ) : typeof setting.value === 'number' ? (
          <input
            type="number"
            className="input w-24 text-right tnum"
            value={value === null || value === undefined ? '' : String(value)}
            // Kept as a number, because the server stores the JSON it is given
            // and a threshold saved as the string "70" compares as text.
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        ) : typeof setting.value === 'string' ? (
          <input
            type="text"
            className="input w-56"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : isStringList(setting.value) ? (
          // A list of words, edited as words. Typed comma-separated and parsed
          // back to an array on the way out, so what is stored stays a list and
          // whatever reads it keeps working. The description on each of these
          // says what the valid entries are.
          <input
            type="text"
            className="input w-72"
            value={Array.isArray(value) ? value.join(', ') : ''}
            placeholder="Available, Booked"
            onChange={(e) => onChange(
              e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
            )}
          />
        ) : (
          // Anything else structured — business hours, an address — is shown and
          // not edited. A text box holding {"end":"19:00",...} is a developer
          // tool wearing a settings screen's clothes, and typing in it would
          // save the object back as a string and break whatever reads it. Each
          // earns a proper control; until then, visible beats corrupt.
          <div className="max-w-xs text-right">
            <p className="truncate font-mono text-2xs text-muted" title={JSON.stringify(value)}>
              {JSON.stringify(value)}
            </p>
            <p className="mt-0.5 text-2xs text-muted">Needs its own editor</p>
          </div>
        )}
      </div>
    </div>
  );
}
