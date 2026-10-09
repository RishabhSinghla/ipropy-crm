import { useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Users, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';

type Draft = { strategy: 'specific_user' | 'round_robin'; userIds: string[] };

export default function FacebookLeadMaster(): JSX.Element {
  const cache = useQueryClient();
  const health = useQuery({ queryKey: ['facebook-health'], queryFn: api.facebookHealth, refetchInterval: 30_000 });
  const users = useQuery({ queryKey: ['facebook-agents'], queryFn: () => api.users(true) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const data = health.data;
  const selected: Draft = draft ?? {
    strategy: data?.assignment?.strategy === 'round_robin' ? 'round_robin' : 'specific_user',
    userIds: data?.assignment?.userIds ?? [],
  };
  const count = (status: string) => data?.queue.find((row) => row.status === status)?.count ?? 0;
  const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Not checked yet';

  const save = async () => {
    setSaving(true);
    try {
      await api.saveFacebookAssignment(selected);
      await cache.invalidateQueries({ queryKey: ['facebook-health'] });
      setDraft(null);
      toast.success('Facebook assignment saved — applies to new contacts only');
    } catch (err) { toast.error((err as Error).message); }
    finally { setSaving(false); }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await api.retryFacebookDeliveries();
      await cache.invalidateQueries({ queryKey: ['facebook-health'] });
      toast.success('Failed deliveries queued for another attempt');
    } catch (err) { toast.error((err as Error).message); }
    finally { setRetrying(false); }
  };

  return <section className="m-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700" data-testid="facebook-lead-master">
    <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4 text-emerald-600" /> Facebook recovery & assignment master</h3>
    {health.isPending && <p className="mt-2 text-sm text-muted">Loading Facebook health…</p>}
    {health.isError && <p role="alert" className="mt-2 text-sm text-red-600">Could not load health. <button className="underline" onClick={() => void health.refetch()}>Try again</button></p>}
    {data && <>
      <div className="my-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[['Waiting', count('pending')], ['Processing', count('processing')], ['Completed', count('done')], ['Needs review', count('dead')]].map(([label, value]) =>
          <div key={label} className="rounded-lg bg-slate-50 p-2 dark:bg-slate-800"><span className="text-muted">{label}</span><p className="text-lg font-semibold">{value}</p></div>)}
      </div>
      <div className="space-y-1 text-xs text-muted">
        <p>Last health check: {date(data.last_checked_at)}</p>
        <p>Last completed reconciliation: {date(data.last_reconciled_at)}</p>
        <p>Token expiry: {data.token_expires_at ? date(data.token_expires_at) : 'Unknown or no scheduled expiry — access can still be revoked'}</p>
        {data.data_access_expires_at && <p>Data-access expiry: {date(data.data_access_expires_at)}</p>}
        <p>{data.forms.length} forms monitored · API {data.graph_version ?? 'not checked'}</p>
        <p>Signed deliveries are saved before acknowledgement. Retries survive restarts; scheduled checks reconcile missed leads. Alerts reach CRM administrators through the bell and registered push devices.</p>
      </div>
      {data.alerts.map((alert) => <p role="alert" key={alert.key} className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">{alert.message}</p>)}
      <button className="btn-secondary btn-sm mt-3" disabled={retrying || (!count('dead') && !count('pending'))} onClick={() => void retry()}><RefreshCw className="h-3 w-3" /> {retrying ? 'Queuing…' : 'Retry failed deliveries'}</button>
    </>}
    <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-700">
      <h4 className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4" /> Who receives NEW Facebook contacts?</h4>
      <p className="mt-1 text-xs text-muted">Existing contacts keep their current owner. Selected agents must be active and have “Include in lead assignment rotation” enabled. If nobody is eligible, the lead stays recoverable and administrators are alerted.</p>
      <label className="label mt-3" htmlFor="facebook-assignment-mode">Assignment method</label>
      <select id="facebook-assignment-mode" className="input" value={selected.strategy}
        onChange={(e) => setDraft({ strategy: e.target.value as Draft['strategy'], userIds: e.target.value === 'specific_user' ? selected.userIds.slice(0, 1) : selected.userIds })}>
        <option value="specific_user">Single agent — every new contact to one person</option>
        <option value="round_robin">Round robin — take turns across selected agents</option>
      </select>
      <fieldset className="mt-3 max-h-48 overflow-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
        <legend className="px-1 text-xs text-muted">Choose agents</legend>
        {users.isError && <p className="text-xs text-red-600">Could not load agents. <button onClick={() => void users.refetch()}>Retry</button></p>}
        {users.data?.map((user) => {
          const id = String(user.id);
          const eligible = Boolean(user.isActive && user.acceptsLeads);
          const checked = selected.userIds.includes(id);
          return <label key={id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
            <input type={selected.strategy === 'specific_user' ? 'radio' : 'checkbox'} name="facebook-agent" checked={checked}
              disabled={!eligible && !checked} onChange={() => setDraft({ ...selected, userIds: selected.strategy === 'specific_user' ? [id]
                : checked ? selected.userIds.filter((item) => item !== id) : [...selected.userIds, id] })} />
            {String(user.fullName ?? '')}
            {!eligible && <span className="text-xs text-amber-700">Not eligible — update Users first</span>}
          </label>;
        })}
      </fieldset>
      <p className="my-2 text-xs text-muted">{selected.userIds.length} selected. Round-robin turns are stored in the database and survive restarts. This master takes precedence over general assignment rules.</p>
      <button className="btn-primary btn-sm" disabled={saving || !selected.userIds.length || health.isPending || health.isError || users.isPending || users.isError} onClick={() => void save()}>{saving ? 'Saving…' : 'Save assignment'}</button>
    </div>
  </section>;
}
