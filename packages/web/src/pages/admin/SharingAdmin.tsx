import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Globe, Images, KeyRound, Lock, Save, ShieldCheck, Unlock, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Select, Skeleton, Spinner } from '../../components/ui';

const ACCESS_LEVELS = [
  { value: 'private', label: 'Private', hint: 'Owners and their managers only', color: '#ef4444' },
  { value: 'public_read', label: 'Public Read', hint: 'Everyone can view, owners can edit', color: '#f59e0b' },
  { value: 'public_read_write', label: 'Public Read/Write', hint: 'Everyone can view and edit', color: '#0ea5e9' },
  { value: 'public_read_write_delete', label: 'Public Full', hint: 'Everyone can view, edit and delete', color: '#22c55e' },
];

export default function SharingAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['sharing'], queryFn: () => api.sharing() });

  useEffect(() => {
    if (!data) return;
    setDefaults(Object.fromEntries(
      (data.defaults as { module: string; access: string }[]).map((d) => [d.module, d.access]),
    ));
    setDirty(false);
  }, [data]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.saveSharingDefaults(defaults);
      toast.success('Sharing rules saved', 'Data visibility updates immediately.');
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['sharing'] });
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const modules = (data?.defaults ?? []) as unknown as { module: string; label: string; access: string }[];
  const rules = (data?.rules ?? []) as unknown as { id: string; module: string; name: string; access: string }[];

  return (
    <div className="p-4 sm:p-6">
      {/*
        Two halves, and the split is the point of the screen.

        This page answers two questions that have almost nothing to do with
        each other: who **on your team** sees whose records, and what somebody
        **with no account at all** sees when you send them a link. They were
        stacked in one scroll with matching cards and a Save button at the top
        that saved only the first of them — so the riskiest control on the page,
        the one that decides what leaves the business, read as one more row of
        settings.

        They are now labelled by consequence rather than by mechanism: getting
        the first wrong means a colleague sees too much, and getting the second
        wrong means a stranger does.
      */}
      <div className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">Data Sharing</h1>
        <p className="text-sm text-muted">
          Who sees what — inside your team, and outside it.
        </p>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Users className="h-4 w-4 text-slate-400" />
        <h2 className="text-sm font-semibold">Inside your team</h2>
        <p className="text-xs text-muted">Which of each other&rsquo;s records your people can open.</p>
        <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm ml-auto">
          {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
        </button>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="list-head">Module</th>
                <th className="list-head">Default access</th>
                <th className="list-head">What it means</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {modules.map((m) => {
                const access = defaults[m.module] ?? 'private';
                const level = ACCESS_LEVELS.find((l) => l.value === access);
                return (
                  <tr key={m.module} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <td className="list-cell">
                      <div className="flex items-center gap-2">
                        {access === 'private'
                          ? <Lock className="h-3.5 w-3.5 text-slate-400" />
                          : <Unlock className="h-3.5 w-3.5 text-slate-400" />}
                        <span className="font-medium">{m.label}</span>
                      </div>
                    </td>
                    <td className="list-cell">
                      <Select
                        value={access}
                        onChange={(v) => { setDefaults({ ...defaults, [m.module]: v }); setDirty(true); }}
                        options={ACCESS_LEVELS.map((l) => ({ value: l.value, label: l.label }))}
                        className="w-52 py-1.5 text-sm"
                      />
                    </td>
                    <td className="list-cell">
                      <span className="text-xs text-muted">{level?.hint}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="mb-2 mt-8 flex flex-wrap items-center gap-2">
        <Globe className="h-4 w-4 text-slate-400" />
        <h2 className="text-sm font-semibold">Outside the CRM</h2>
        <p className="text-xs text-muted">
          What a customer sees on a link you send them. They need no account, so anything ticked
          here is readable by anyone who has the link.
        </p>
      </div>

      <OutsideLinkControls />

      {rules.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Sharing rules</p>
            <p className="text-xs text-muted">
              Grant one team access to another's records without changing the org-wide default.
            </p>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="text-sm">{r.name}</span>
                <Badge className="ml-auto">{r.module}</Badge>
                <Badge color={r.access === 'read_write' ? '#0ea5e9' : '#94a3b8'}>
                  {r.access.replace('_', '/')}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900 text-muted">
        <p className="mb-1.5 font-medium text-slate-700 dark:text-slate-300">How access is decided</p>
        <ol className="list-inside list-decimal space-y-1">
          <li>The user's <strong>profile</strong> must allow the action on the module at all.</li>
          <li>The <strong>org-wide default</strong> above applies to everyone.</li>
          <li><strong>Role hierarchy</strong> — managers automatically see their reports' records.</li>
          <li><strong>Sharing rules</strong> grant extra access between roles, teams or individuals.</li>
          <li><strong>Per-record shares</strong> let a user hand one record to a colleague.</li>
        </ol>
      </div>
    </div>
  );
}

/**
 * What somebody with no account sees on a link you send them.
 *
 * Per module, because a matching tab shares contacts as well as units now and
 * that asks the same question of a different record. It was properties-only,
 * and the reason people could not be shared at all was that there was nowhere
 * to answer this question for them.
 *
 * The list below is **not** every field. The server refuses to offer a mobile,
 * an email, an owner or anything else that reads as identity or contact
 * (`isShareable` in `core/sharing/propertyShare.ts`) — so those cannot be
 * exposed by ticking the wrong box, and the worst an admin can do here is show
 * a name they meant to keep back. That is a decision a business is entitled to
 * make about its own records, and it has to be made on purpose: everything
 * identifying starts off.
 */
function OutsideLinkControls(): JSX.Element {
  const queryClient = useQueryClient();
  const { modules: allModules } = useApp();
  const shareable = (allModules ?? []).filter((m) => m.isEntity);
  const [moduleName, setModuleName] = useState('properties');
  const [visible, setVisible] = useState<string[]>([]);
  const [showPhotos, setShowPhotos] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['share-config', moduleName],
    queryFn: () => api.shareLinkConfig(moduleName),
  });

  useEffect(() => {
    if (!data) return;
    setVisible(data.fields.filter((field) => field.visible).map((field) => field.name));
    setShowPhotos(data.showPhotos);
    setDirty(false);
  }, [data]);

  const toggle = (name: string): void => {
    setVisible((current) => current.includes(name)
      ? current.filter((field) => field !== name)
      : [...current, name]);
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.saveShareLinkConfig(moduleName, { visibleFields: visible, showPhotos });
      toast.success('Link view updated', 'Every link already sent uses these rules from now on.');
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['share-config', moduleName] });
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /*
    Fields that name or place the record. Flagged rather than blocked: a unit
    number is how a buyer knows which floor they were shown, and a contact's
    name is how a channel partner knows who to ring — both are legitimate to
    share and neither should be switched on without noticing.
  */
  const identifying = new Set([
    'name', 'full_name', 'project_name', 'tower', 'block_tower', 'wing',
    'unit_number', 'unit_no', 'city', 'locality', 'preferred_locations', 'address',
  ]);

  return (
    <div className="card mt-4 overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 border-b border-slate-100 p-4 dark:border-slate-800">
        <div className="flex min-w-0 flex-1 gap-3">
          <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Only what you tick leaves the CRM</p>
            <p className="text-xs text-muted">
              Phone numbers, email addresses and who owns the record are never offered here —
              the server withholds them whatever is ticked. Anything that names or places a
              record starts off.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Which module's links these rules apply to. Both are shareable now;
              each keeps its own answer. */}
          <Select
            value={moduleName}
            onChange={(v) => { setModuleName(v); setDirty(false); }}
            options={shareable.map((m) => ({ value: m.name, label: m.label }))}
            className="w-40 py-1.5 text-sm"
          />
          <button type="button" onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm">
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : (
        <div className="space-y-4 p-4">
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <input
              type="checkbox"
              checked={showPhotos}
              onChange={(event) => { setShowPhotos(event.target.checked); setDirty(true); }}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <Images className="h-4 w-4 text-slate-400" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Show photos</span>
              <span className="block text-xs text-muted">Obvious blurred, dark and duplicate photos remain excluded automatically.</span>
            </span>
          </label>

          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Visible details</p>
              <span className="ml-auto text-xs text-muted">{visible.length} of {data.fields.length} shown</span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => { setVisible([]); setDirty(true); }}
              >
                <EyeOff className="h-3.5 w-3.5" /> Hide all
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {data.fields.map((field) => {
                const checked = visible.includes(field.name);
                return (
                  <label
                    key={field.name}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 transition-colors',
                      checked
                        ? 'border-brand-200 bg-brand-50/50 dark:border-brand-800 dark:bg-brand-950/20'
                        : 'border-slate-200 dark:border-slate-700',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(field.name)}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    {checked ? <Eye className="h-3.5 w-3.5 text-brand-600" /> : <EyeOff className="h-3.5 w-3.5 text-slate-300" />}
                    <span className="min-w-0 flex-1 truncate text-sm">{field.label}</span>
                    {identifying.has(field.name) && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                        identifying
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted dark:bg-slate-900">
            This applies immediately to every link already sent, not only to new ones. Hidden values
            are removed by the server before the page is built, so they never reach the browser.
            {visible.length === 0 && ' With nothing ticked, a link for these records answers “no longer available”.'}
          </p>
        </div>
      )}
    </div>
  );
}
