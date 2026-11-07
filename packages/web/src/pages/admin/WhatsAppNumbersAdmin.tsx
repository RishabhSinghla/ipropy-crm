import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type WaNumber } from '../../lib/api';
import { Badge, Skeleton } from '../../components/ui';
import { toast } from '../../lib/store';

/**
 * Admin → WhatsApp numbers. Each row is one WhatsApp number (an OpenWA session). An admin pairs it with a QR code,
 * says which agent works from it, and can pause it. An agent sends only from their own number; admins pick.
 */
function QrBox({ id }: { id: string }): JSX.Element {
  const { data } = useQuery({
    queryKey: ['wa-numbers', 'qr', id],
    queryFn: () => api.waNumberQr(id),
    refetchInterval: 8_000,
  });
  if (!data) return <Skeleton className="h-48 w-48" />;
  if (!data.qrCode) {
    return <p className="text-sm text-muted">No QR to show right now (status: {data.status}). Press Start first, then wait a few seconds.</p>;
  }
  return (
    <div>
      <img src={data.qrCode} alt="WhatsApp pairing QR code" className="h-48 w-48 rounded border" />
      <p className="mt-1 text-sm text-muted">On the phone: WhatsApp → Settings → Linked devices → Link a device, then scan this.</p>
    </div>
  );
}

function NumberCard({ n, agents }: { n: WaNumber; agents: { id: string; name: string }[] }): JSX.Element {
  const qc = useQueryClient();
  const [qr, setQr] = useState(n.status === 'qr_ready' && !n.paused);
  const refresh = () => qc.invalidateQueries({ queryKey: ['wa-numbers'] });
  const fail = (title: string) => (err: unknown) => toast.error(title, err instanceof Error ? err.message : 'Something went wrong');
  const control = useMutation({
    mutationFn: (a: 'start' | 'stop' | 'restart' | 'unlink') => api.waNumberControl(n.id, a),
    onSuccess: () => void refresh(), onError: fail('Number'),
  });
  const assign = useMutation({
    mutationFn: (userId: string | null) => api.waNumberAssign(n.id, userId),
    onSuccess: () => { toast.success('Saved'); void refresh(); }, onError: fail('Assign'),
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.waNumberPause(n.id, paused),
    onSuccess: () => void refresh(), onError: fail('Pause'),
  });
  const remove = useMutation({
    mutationFn: () => api.waNumberDelete(n.id),
    onSuccess: () => { toast.success('Removed', `${n.label || n.sessionName} is gone from the list.`); void refresh(); },
    onError: fail('Remove'),
  });
  const makeDefault = useMutation({ mutationFn: () => api.waNumberDefault(n.id), onSuccess: () => void refresh(), onError: fail('Default') });
  const hook = useMutation({
    mutationFn: () => api.waNumberWebhook(n.id),
    onSuccess: () => toast.success('Connected', 'This number now reports messages to the CRM.'), onError: fail('Connect'),
  });
  const catchUp = useMutation({
    mutationFn: (dryRun: boolean) => api.waCatchUp(n.id, dryRun),
    onSuccess: (r, dryRun) => toast.success(dryRun ? 'Checked (nothing saved)' : 'Caught up', `Looked back to ${new Date(r.since).toLocaleString('en-IN')}: ${r.fetched} found, ${dryRun ? `${r.stored} would be new` : `${r.stored} new`}, ${r.alreadyHad} already here, ${r.skipped} skipped.`),
    onError: fail('Catch up'),
  });
  const ready = n.status === 'ready';
  const trouble = !ready && !n.paused;
  return (
    <div className="card p-4" data-testid="wa-number-card">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{n.label || n.sessionName}</h3>
        <Badge>{n.sessionName}</Badge>
        {n.isDefault && <Badge>Company number</Badge>}
        {n.paused ? <Badge>Paused</Badge> : <Badge>{ready ? 'Connected' : n.statusText}</Badge>}
        {n.phone && <span className="text-sm text-muted">{n.phone}</span>}
        {!ready && n.statusSince && (
          <span className="text-sm font-medium text-negative" data-testid="wa-number-down-since">
            {n.alerted ? 'Down' : 'Not connected'} since {new Date(n.statusSince).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted" data-testid="wa-number-facts">
        Sent today: {n.messagesToday ?? 0}{n.failedToday ? ` (${n.failedToday} failed)` : ''}
        {' · '}Last active: {n.lastActiveAt ? new Date(n.lastActiveAt).toLocaleString('en-IN') : 'never'}
        {n.statusSince ? ` · Status since ${new Date(n.statusSince).toLocaleString('en-IN')}` : ''}
        {n.restartAttempts ? ` · Automatic restarts tried: ${n.restartAttempts}` : ''}
      </p>
      {(n.lastError || trouble) && (
        <p role="alert" className="mt-1 text-sm" data-testid="wa-number-error">
          {n.lastError ?? `Not connected: ${n.statusText}.`}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          Agent{' '}
          <select
            className="input ml-1 inline-block w-52"
            value={n.userId ?? ''}
            onChange={(e) => assign.mutate(e.target.value || null)}
            aria-label={`Agent for ${n.sessionName}`}
          >
            <option value="">Nobody</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <button className="btn-secondary btn-sm" onClick={() => control.mutate('start')} disabled={control.isPending}>Start</button>
        <button className="btn-secondary btn-sm" onClick={() => control.mutate('restart')} disabled={control.isPending}>Restart</button>
        <button className="btn-secondary btn-sm" onClick={() => control.mutate('stop')} disabled={control.isPending}>Stop</button>
        <button className="btn-secondary btn-sm" onClick={() => setQr((v) => !v)}>{qr ? 'Hide QR' : 'Show QR'}</button>
        <button
          className="btn-secondary btn-sm"
          onClick={() => { if (window.confirm('Unlink this phone from WhatsApp? A new QR scan is needed after.')) control.mutate('unlink'); }}
        >Unlink</button>
        <button className="btn-secondary btn-sm" onClick={() => catchUp.mutate(false)} disabled={catchUp.isPending || !ready} title="Fetch customer messages this number received while the CRM was not listening">Catch up messages</button>
        <button className="btn-secondary btn-sm" onClick={() => hook.mutate()} title="Make this number report messages to the CRM">Connect to CRM</button>
        {!n.isDefault && <button className="btn-secondary btn-sm" onClick={() => makeDefault.mutate()}>Make company number</button>}
        {!n.isDefault && !ready && (
          <button
            className="btn-secondary btn-sm"
            title="Only for leftover or test numbers that never sent a message"
            disabled={remove.isPending}
            onClick={() => { if (window.confirm(`Remove ${n.label || n.sessionName} from the CRM and from OpenWA? This cannot be undone.`)) remove.mutate(); }}
          >Remove number</button>
        )}
        <button className={n.paused ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => pause.mutate(!n.paused)}>
          {n.paused ? 'Resume sending' : 'Pause this number'}
        </button>
      </div>
      {qr && <div className="mt-3"><QrBox id={n.id} /></div>}
    </div>
  );
}

/** Numbers that only a person with the phone can bring back: a loud, specific list at the top of the screen. */
function NeedsScanBanner({ numbers }: { numbers: WaNumber[] }): JSX.Element | null {
  const stuck = numbers.filter((n) => !n.paused && (n.status === 'qr_ready' || n.status === 'disconnected') && (n.isDefault || n.userId || n.lastActiveAt));
  if (stuck.length === 0) return null;
  return (
    <div role="alert" data-testid="wa-needs-scan" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
      <p className="font-semibold">{stuck.length === 1 ? '1 WhatsApp number needs a QR scan' : `${stuck.length} WhatsApp numbers need a QR scan`}</p>
      <ul className="mt-1 list-disc pl-5">
        {stuck.map((n) => (
          <li key={n.id}>
            {n.label || n.sessionName}{n.userName ? ` (${n.userName})` : ''} is logged out. {n.userName ? `Ask ${n.userName} to open Settings → My WhatsApp and scan the code, or press Show QR on its card and scan it from their phone.` : 'Press Show QR on its card and scan it from the phone.'}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs">Restarting cannot fix this: WhatsApp logged the phone out, so it must be linked again.</p>
    </div>
  );
}

function CapacityBox(): JSX.Element | null {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['wa-numbers', 'capacity'], queryFn: () => api.waCapacity(), refetchInterval: 30_000 });
  const [maxLive, setMaxLive] = useState<string>('');
  const [mem, setMem] = useState<string>('');
  const save = useMutation({
    mutationFn: () => api.waCapacitySave(Number(maxLive || data?.capacity.maxLive), Number(mem || data?.capacity.memoryLimitMb)),
    onSuccess: () => { setMaxLive(''); setMem(''); toast.success('Saved'); void qc.invalidateQueries({ queryKey: ['wa-numbers'] }); },
    onError: (err) => toast.error('Capacity', err instanceof Error ? err.message : 'Something went wrong'),
  });
  if (!data) return null;
  return (
    <div className="card p-4" data-testid="wa-capacity">
      <h3 className="text-base font-semibold">OpenWA server room</h3>
      <p className="mt-1 text-sm">
        {data.live} of {data.capacity.maxLive} numbers connected
        {data.rssMb !== null ? ` · server memory ${Math.round(data.rssMb)} of ${data.capacity.memoryLimitMb} MB` : ''}.
      </p>
      {!data.room.ok && <p role="alert" className="mt-1 text-sm">{data.room.reason}</p>}
      <p className="mt-1 text-sm text-muted">
        Starting a number beyond this limit is refused, so the company number cannot be knocked offline. After the OpenWA server is moved to a
        bigger Render plan, raise the limit here (see docs/OPENWA.md, “Upgrading the OpenWA server”).
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-sm">Most numbers connected at once
          <input className="input mt-1 block w-28" inputMode="numeric" value={maxLive} placeholder={String(data.capacity.maxLive)} onChange={(e) => setMaxLive(e.target.value)} />
        </label>
        <label className="text-sm">Server memory (MB)
          <input className="input mt-1 block w-28" inputMode="numeric" value={mem} placeholder={String(data.capacity.memoryLimitMb)} onChange={(e) => setMem(e.target.value)} />
        </label>
        <button className="btn-secondary btn-sm" disabled={(!maxLive && !mem) || save.isPending} onClick={() => save.mutate()}>Save</button>
      </div>
    </div>
  );
}

export default function WhatsAppNumbersAdmin(): JSX.Element {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const numbers = useQuery({ queryKey: ['wa-numbers', 'list'], queryFn: () => api.waNumbers(), refetchInterval: 15_000 });
  const users = useQuery({
    queryKey: ['wa-numbers', 'users'],
    queryFn: async () => (await api.users(false, false, true)).map((u) => ({
      id: String(u.id), name: `${String(u.first_name ?? u.firstName ?? '')} ${String(u.last_name ?? u.lastName ?? '')}`.trim() || String(u.email ?? u.id),
    })),
  });
  const refresh = useMutation({
    mutationFn: () => api.waNumbersRefresh(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-numbers'] }),
    onError: (err) => toast.error('Refresh', err instanceof Error ? err.message : 'Something went wrong'),
  });
  const create = useMutation({
    mutationFn: () => api.waNumberCreate(name.trim()),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: ['wa-numbers'] }); },
    onError: (err) => toast.error('New number', err instanceof Error ? err.message : 'Something went wrong'),
  });
  const log = useQuery({ queryKey: ['wa-numbers', 'log'], queryFn: () => api.waNumberLog() });

  if (numbers.error) {
    return <div className="p-6"><p role="alert" className="text-sm">Could not load the numbers: {(numbers.error as Error).message}</p></div>;
  }
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h2 className="text-lg font-semibold">WhatsApp numbers</h2>
        <p className="mt-1 text-sm text-muted">
          One WhatsApp number per agent. An agent chats with their own leads from their own number only; you can see and use every
          number. The company number is the fallback for leads whose agent has no number. This is the plain WhatsApp chat — the
          official API (automatic messages) is separate and unchanged.
        </p>
        <p className="mt-1 text-sm text-muted">
          Note: WhatsApp does not officially allow robots on personal numbers. The CRM spaces out sends and caps them per number;
          never use these numbers for bulk messages.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">New session name
          <input className="input mt-1 block w-60" value={name} onChange={(e) => setName(e.target.value)} placeholder="for example shikha-phone" />
        </label>
        <button className="btn-primary btn-sm" disabled={name.trim().length < 2 || create.isPending} onClick={() => create.mutate()}>Add number</button>
        <button className="btn-secondary btn-sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh from OpenWA</button>
      </div>
      <NeedsScanBanner numbers={numbers.data ?? []} />
      <CapacityBox />
      {numbers.isLoading ? <Skeleton className="h-32 w-full" /> : (numbers.data ?? []).map((n) => (
        <NumberCard key={n.id} n={n} agents={users.data ?? []} />
      ))}
      {numbers.data?.length === 0 && <p className="text-sm text-muted">No numbers yet. Press “Refresh from OpenWA” to bring in the existing ones.</p>}
      <div className="card p-4">
        <h3 className="text-base font-semibold">Who sent what, from which number</h3>
        <div className="mt-2 max-h-72 overflow-auto text-sm">
          {(log.data ?? []).slice(0, 50).map((r) => (
            <div key={r.id} className="flex flex-wrap gap-x-3 border-b py-1">
              <span className="text-muted">{new Date(r.created_at).toLocaleString('en-IN')}</span>
              <strong>{r.sent_by_name ?? '—'}</strong>
              <span>from {r.number_label ?? 'unknown number'}</span>
              <span>to …{r.handle.slice(-4)}</span>
              <span className="truncate text-muted">{r.body}</span>
            </div>
          ))}
          {log.data?.length === 0 && <p className="text-muted">Nothing sent yet.</p>}
        </div>
      </div>
    </div>
  );
}
