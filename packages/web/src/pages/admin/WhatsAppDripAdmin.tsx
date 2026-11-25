import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ChevronDown, ChevronUp, Pause, Play, Send, ShieldAlert, Users } from 'lucide-react';
import { api, type WaDrip } from '../../lib/api';
import { toast } from '../../lib/store';
import { Badge, Modal, Skeleton, Spinner } from '../../components/ui';

/**
 * The slow promotional drip on the linked WhatsApp numbers.
 *
 * Nothing sends on a click. You pick a saved list and the wordings, are shown how many people that is (and who is left
 * out and why), and only then is there a Start button — which passes that number back, so a list that has changed since
 * you looked is refused. After Start the CRM sends one message every minute or two, a few dozen a day per number, only in
 * daytime, and pauses itself — and tells the admins — when anything looks wrong. Only a person presses Resume.
 */
const LABEL: Record<string, string> = { draft: 'Not started', running: 'Running', paused: 'Paused', done: 'Finished', stopped: 'Stopped' };
const TONE: Record<string, string | undefined> = { draft: undefined, running: '#14b86a', paused: '#f59e0b', done: '#2563eb', stopped: '#64748b' };

export default function WhatsAppDripAdmin(): JSX.Element {
  const qc = useQueryClient();
  const [building, setBuilding] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ['wa-drip'], queryFn: () => api.dripList(), refetchInterval: 20_000 });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ['wa-drip'] }); };

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;
  if (error) return <div className="p-6"><p role="alert" className="text-sm">Could not load the drip: {(error as Error).message}</p></div>;
  const drips = data?.drips ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight">WhatsApp drip</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            One promotional message, sent slowly from the linked phones to people on a saved list — about one every minute or two,
            a few dozen a day per phone, daytime only. Each person is messaged once, ever. Anyone who replies STOP is never messaged again.
          </p>
        </div>
        <button className="btn-primary btn-sm" onClick={() => setBuilding(true)}><Send className="h-3.5 w-3.5" /> New queue</button>
      </div>

      <RiskNote />

      {!drips.length ? (
        <p className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-sm text-muted dark:border-slate-700">No queues yet.</p>
      ) : drips.map((d) => <DripCard key={d.id} drip={d} onChanged={refresh} />)}

      {building && <NewQueue defaults={data!.defaults} onClose={() => { setBuilding(false); refresh(); }} />}
    </div>
  );
}

function RiskNote(): JSX.Element {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <p><strong>Read this once.</strong> WhatsApp does not allow robots or promotions on linked phones. Even this slow drip can get a phone
          limited or banned — the phones are real people&apos;s numbers. It is slower than most (20 a day per phone to start, 40 at most) and it stops
          itself at the first sign of trouble, but it cannot make the risk zero. The official WhatsApp route (WhatsMarketing, approved templates) is the safe way to message many people.</p>
        <p>India&apos;s rules on promotional messages (TRAI) and on personal data (DPDP) still apply: message only people who have a reason to expect it, keep the STOP line, and honour every STOP.</p>
      </div>
    </div>
  );
}

function DripCard({ drip, onChanged }: { drip: WaDrip; onChanged: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const pause = useMutation({
    mutationFn: () => api.dripPause(drip.id),
    onSuccess: () => { onChanged(); toast.success('Paused'); },
    onError: (err: Error) => toast.error('Could not pause', err.message),
  });
  const stop = useMutation({
    mutationFn: () => api.dripStop(drip.id),
    onSuccess: () => { onChanged(); toast.success('Stopped'); },
    onError: (err: Error) => toast.error('Could not stop', err.message),
  });
  const detail = useQuery({ queryKey: ['wa-drip', drip.id], queryFn: () => api.dripDetail(drip.id), enabled: open, refetchInterval: open ? 20_000 : false });

  const total = drip.counts.sent + drip.counts.failed + drip.counts.skipped + drip.counts.pending;
  const pct = (n: number): string => `${total ? (n / total) * 100 : 0}%`;
  const live = drip.status === 'running' || drip.status === 'paused';

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {drip.name} <Badge color={TONE[drip.status]}>{LABEL[drip.status]}</Badge>
            {drip.status === 'running' && !drip.insideWindow && <Badge color="#64748b">waiting for daytime</Badge>}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {drip.approvedCount !== null && `${drip.approvedCount.toLocaleString('en-IN')} people · `}
            {drip.capToday} a day per number today · gap {drip.speed.gapMinSeconds}–{drip.speed.gapMaxSeconds}s · {drip.speed.windowFrom}:00–{drip.speed.windowTo}:00
            {drip.maxTotal ? ` · stops after ${drip.maxTotal}` : ''}
          </p>
        </div>
        {drip.status === 'running' && (
          <button className="btn-secondary btn-sm" disabled={pause.isPending} onClick={() => pause.mutate()}><Pause className="h-3.5 w-3.5" /> Pause</button>
        )}
        {drip.status === 'paused' && (
          <button className="btn-primary btn-sm" onClick={() => setResuming(true)}><Play className="h-3.5 w-3.5" /> Resume</button>
        )}
        {live && (
          <button className="btn-secondary btn-sm" disabled={stop.isPending} onClick={() => { if (window.confirm('Stop this queue for good? People not yet messaged will not be.')) stop.mutate(); }}>
            <Ban className="h-3.5 w-3.5" /> Stop
          </button>
        )}
      </div>

      {drip.status === 'paused' && drip.pauseReason && (
        <p role="alert" className={`mt-3 rounded-md p-2 text-sm ${drip.pausedBySystem ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>
          {drip.pausedBySystem && <strong>Paused itself. </strong>}{drip.pauseReason}
        </p>
      )}

      {total > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <span className="bg-emerald-500" style={{ width: pct(drip.counts.sent) }} />
            <span className="bg-rose-500" style={{ width: pct(drip.counts.failed) }} />
            <span className="bg-amber-400" style={{ width: pct(drip.counts.skipped) }} />
          </div>
          <p className="flex flex-wrap gap-x-4 text-xs text-muted">
            <span><strong className="text-slate-700 dark:text-slate-200">{drip.counts.sent}</strong> sent</span>
            {drip.counts.pending > 0 && <span>{drip.counts.pending.toLocaleString('en-IN')} to go</span>}
            {drip.counts.skipped > 0 && <span><strong className="text-amber-600">{drip.counts.skipped}</strong> left out</span>}
            {drip.counts.failed > 0 && <span><strong className="text-rose-600">{drip.counts.failed}</strong> failed</span>}
            {drip.repliedStop > 0 && <span><strong>{drip.repliedStop}</strong> replied STOP</span>}
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {drip.numbers.map((n) => (
          <span key={n.numberId} className={`rounded-md border px-2 py-1 text-xs ${n.status === 'ready' && !n.paused ? 'border-slate-200 dark:border-slate-700' : 'border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300'}`}>
            {n.label}: {n.sentToday}/{n.capToday} today{n.status !== 'ready' ? ` · ${n.status}` : n.paused ? ' · paused' : ''}
          </span>
        ))}
      </div>

      <button className="mt-3 flex items-center gap-1 text-xs text-muted hover:underline" onClick={() => setOpen(!open)}>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} What happened, and who was left out
      </button>
      {open && (
        <div className="mt-2 space-y-3 text-sm">
          {detail.isLoading && <Spinner className="h-4 w-4" />}
          {detail.data && (
            <>
              {detail.data.skips.length > 0 && (
                <div>
                  <p className="font-medium">Left out</p>
                  <ul className="text-muted">{detail.data.skips.map((s) => <li key={s.reason}>{s.count} — {s.words}</li>)}</ul>
                </div>
              )}
              <div>
                <p className="font-medium">History (who, which number, when)</p>
                <div className="max-h-56 overflow-auto">
                  {detail.data.events.map((e) => (
                    <div key={e.id} className="border-b py-1 text-xs">
                      <span className="text-muted">{new Date(e.at).toLocaleString('en-IN')}</span> · <strong>{e.kind.replace('_', ' ')}</strong>
                      {e.by ? ` · ${e.by}` : ' · the system'}{e.number ? ` · ${e.number}` : ''}{e.detail ? ` — ${e.detail}` : ''}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="font-medium">Latest messages</p>
                <div className="max-h-56 overflow-auto">
                  {detail.data.recent.map((r) => (
                    <div key={r.id} className="border-b py-1 text-xs">
                      <span className="text-muted">{r.at ? new Date(r.at).toLocaleString('en-IN') : ''}</span> · {r.label ?? 'contact'} · {r.number ?? ''} ·{' '}
                      <strong className={r.status === 'failed' ? 'text-rose-600' : ''}>{r.status}</strong>{r.error ? ` — ${r.error}` : ''}
                    </div>
                  ))}
                  {detail.data.recent.length === 0 && <p className="text-xs text-muted">Nothing sent yet.</p>}
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {resuming && <ResumeDialog drip={drip} onClose={() => { setResuming(false); onChanged(); }} />}
    </section>
  );
}

function ResumeDialog({ drip, onClose }: { drip: WaDrip; onClose: () => void }): JSX.Element {
  const { data: numbers } = useQuery({ queryKey: ['wa-numbers'], queryFn: () => api.waNumbers() });
  const [picked, setPicked] = useState<string[]>(drip.numberIds);
  const resume = useMutation({
    mutationFn: () => api.dripResume(drip.id, picked),
    onSuccess: () => { toast.success('Resumed'); onClose(); },
    onError: (err: Error) => toast.error('Not resumed', err.message),
  });
  const ready = (numbers ?? []).filter((n) => n.status === 'ready' && !n.paused);
  return (
    <Modal open onClose={onClose} title="Resume this queue" footer={(
      <>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!picked.length || resume.isPending} onClick={() => resume.mutate()}>Resume</button>
      </>
    )}>
      <p className="text-sm text-muted">Fix whatever paused it first. If a phone is still down, leave it out here: the queue then carries on with the others.</p>
      <NumberPicker numbers={ready} picked={picked} setPicked={setPicked} />
    </Modal>
  );
}

function NumberPicker({ numbers, picked, setPicked }: {
  numbers: { id: string; label: string | null; sessionName: string }[]; picked: string[]; setPicked: (ids: string[]) => void;
}): JSX.Element {
  return (
    <div className="mt-2 space-y-1">
      {numbers.map((n) => (
        <label key={n.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={picked.includes(n.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, n.id] : picked.filter((x) => x !== n.id))} />
          {n.label || n.sessionName}
        </label>
      ))}
      {numbers.length === 0 && <p className="text-sm text-rose-600">No phone is connected and ready. Link one on the WhatsApp numbers screen.</p>}
    </div>
  );
}

function NewQueue({ defaults, onClose }: { defaults: { variants: string[]; hardMaxPerNumberPerDay: number; minGapSeconds: number }; onClose: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [view, setView] = useState('');
  const [variants, setVariants] = useState<string[]>(defaults.variants);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [capStart, setCapStart] = useState(20);
  const [windowFrom, setWindowFrom] = useState(10);
  const [windowTo, setWindowTo] = useState(18);
  const [maxTotal, setMaxTotal] = useState('');
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [testTo, setTestTo] = useState('');

  const { data: views } = useQuery({ queryKey: ['views', 'leads'], queryFn: () => api.views('leads') });
  const { data: numbers } = useQuery({ queryKey: ['wa-numbers'], queryFn: () => api.waNumbers() });
  const ready = (numbers ?? []).filter((n) => n.status === 'ready' && !n.paused);
  const chosen = picked ?? ready.map((n) => n.id);

  const preview = useMutation({
    mutationFn: () => api.dripPreview(view, variants),
    onError: (err: Error) => toast.error('Could not work out who that is', err.message),
  });
  const test = useMutation({
    mutationFn: () => api.dripTest({ mobile: testTo, numberId: chosen[0]!, variants }),
    onSuccess: (r) => toast.success('Test sent', `To ${r.to}. Check the phone.`),
    onError: (err: Error) => toast.error('Test not sent', err.message),
  });
  const start = useMutation({
    mutationFn: async () => {
      const made = await api.dripCreate({
        name, view, variants, numberIds: chosen, maxTotal: maxTotal ? Number(maxTotal) : null,
        speed: { capStart, windowFrom, windowTo },
      });
      try {
        return await api.dripStart(made.id, preview.data!.reachable, confirmLarge);
      } catch (err) {
        await api.dripStop(made.id).catch(() => undefined); // tidy: a queue that never started is not left lying about
        throw err;
      }
    },
    onSuccess: (r) => { toast.success(`Started for ${r.frozen.toLocaleString('en-IN')} people`, 'One message every minute or two, in daytime.'); onClose(); },
    onError: (err: Error) => toast.error('Not started', err.message),
  });

  const counted = preview.data;
  const large = (counted?.reachable ?? 0) > 500;
  const ok = Boolean(name.trim() && view && chosen.length && variants.every((v) => v.trim().length >= 20));
  const days = counted ? Math.ceil(counted.reachable / Math.max(1, capStart * Math.max(1, chosen.length))) : 0;

  return (
    <Modal open onClose={onClose} title="New WhatsApp drip queue" size="lg" footer={(
      <>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-secondary" disabled={!ok || preview.isPending} onClick={() => preview.mutate()}>
          {preview.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />} Who would get this?
        </button>
        {counted && (
          <button className="btn-primary" disabled={start.isPending || counted.reachable === 0 || Boolean(counted.problem) || (large && !confirmLarge)} onClick={() => start.mutate()}>
            {start.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} Start for {counted.reachable.toLocaleString('en-IN')}
          </button>
        )}
      </>
    )}>
      <div className="space-y-3 text-sm">
        <label className="block">Name
          <input className="input mt-1 block w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="for example Greenfields builder floors" />
        </label>
        <label className="block">Who (a saved list of contacts)
          <select className="input mt-1 block w-full" value={view} onChange={(e) => { setView(e.target.value); preview.reset(); }}>
            <option value="">Choose a saved list…</option>
            {(views ?? []).map((v: { id: string; label?: string; name?: string }) => <option key={v.id} value={v.id}>{v.name ?? v.label}</option>)}
          </select>
        </label>

        <div>
          <p>Wordings <span className="text-muted">(each person gets one; <code>{'{name}'}</code> becomes their first name when known; “Reply STOP to stop” is added to every message)</span></p>
          {variants.map((v, i) => (
            <div key={i} className="mt-1 flex gap-2">
              <textarea className="input block min-h-[84px] w-full" value={v} onChange={(e) => { setVariants(variants.map((x, j) => (j === i ? e.target.value : x))); preview.reset(); }} />
              {variants.length > 1 && <button className="btn-secondary btn-sm self-start" onClick={() => { setVariants(variants.filter((_, j) => j !== i)); preview.reset(); }}>Remove</button>}
            </div>
          ))}
          {variants.length < 6 && <button className="btn-secondary btn-sm mt-1" onClick={() => setVariants([...variants, ''])}>Add another wording</button>}
        </div>

        <div>
          <p>Send from</p>
          <NumberPicker numbers={ready} picked={chosen} setPicked={(ids) => { setPicked(ids); preview.reset(); }} />
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <label>Per phone per day (start)
            <input type="number" min={1} max={defaults.hardMaxPerNumberPerDay} className="input mt-1 block w-full" value={capStart} onChange={(e) => setCapStart(Number(e.target.value))} />
          </label>
          <label>From hour
            <input type="number" min={6} max={20} className="input mt-1 block w-full" value={windowFrom} onChange={(e) => setWindowFrom(Number(e.target.value))} />
          </label>
          <label>Until hour
            <input type="number" min={8} max={21} className="input mt-1 block w-full" value={windowTo} onChange={(e) => setWindowTo(Number(e.target.value))} />
          </label>
          <label>Stop after (optional)
            <input type="number" min={1} className="input mt-1 block w-full" placeholder="e.g. 5" value={maxTotal} onChange={(e) => setMaxTotal(e.target.value)} />
          </label>
        </div>
        <p className="text-xs text-muted">
          It rises by 5 every 3 days it really sends, never above {defaults.hardMaxPerNumberPerDay} a day per phone, with at least {defaults.minGapSeconds} seconds between messages. Those limits are fixed in the CRM.
        </p>

        <div className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
          <p className="font-medium">First, a test to yourself</p>
          <p className="text-xs text-muted">Type your own mobile number. It must already be a contact in the CRM (add yourself first). Sent from the first number ticked above.</p>
          <div className="mt-2 flex gap-2">
            <input className="input w-48" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="10-digit mobile" />
            <button className="btn-secondary btn-sm" disabled={testTo.replace(/\D/g, '').length < 10 || !chosen.length || test.isPending || variants.some((v) => v.trim().length < 20)} onClick={() => test.mutate()}>Send me a test</button>
          </div>
        </div>

        {counted && (
          <div className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <p><strong>{counted.reachable.toLocaleString('en-IN')}</strong> people can be messaged{counted.total !== counted.reachable ? ` (the list has ${counted.total.toLocaleString('en-IN')})` : ''}.
              {' '}At {capStart} a day on {chosen.length} phone{chosen.length === 1 ? '' : 's'} that is at least {days.toLocaleString('en-IN')} days.</p>
            {counted.problem && <p className="mt-1 text-rose-600">{counted.problem}</p>}
            {counted.skippedByReason.length > 0 && (
              <ul className="mt-1 text-xs text-muted">{counted.skippedByReason.map((s) => <li key={s.reason}>{s.count} left out — {s.words}</li>)}</ul>
            )}
            {counted.sample.map((s, i) => (
              <pre key={i} className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs dark:bg-slate-900"><span className="text-muted">{s.label} · {s.to}{'\n'}</span>{s.text}</pre>
            ))}
            {large && (
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={confirmLarge} onChange={(e) => setConfirmLarge(e.target.checked)} /> I understand this is a large queue and will take weeks or months.</label>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
