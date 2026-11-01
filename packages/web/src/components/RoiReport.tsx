/**
 * "What earns money" — a Dashboard section answering which channel, template
 * and agent turn contacts into replies, visits and deals. All numbers come
 * from one server call (`/api/dashboards/roi`); nothing is computed in the
 * browser except percentages and the CSV.
 */
import { useMemo, useState, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Info } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { Skeleton } from './ui';

interface Counts {
  touches: number; calls: number; messages: number; leads: number; sent: number; delivered: number; read: number; replied: number;
  failed: number; answered: number; qualified: number; visitFixed: number; visitDone: number; won: number;
  nowVisit: number; nowWon: number; cost: number; costUnknown: number;
}
type Failure = { reason: string; count: number };
type ChannelRow = Counts & { channel: string; topFailures: Failure[] };
type TemplateRow = Counts & { template: string; category: string; topFailures: Failure[] };
type AgentRow = Counts & { agentId: string | null; agent: string; medianResponseMinutes: number | null };
interface Report {
  total: Counts; previous: Counts; channels: ChannelRow[]; templates: TemplateRow[]; agents: AgentRow[];
  costs: Record<string, number>;
  options: { sources: string[]; agents: { id: string; name: string }[] };
  scopedToMe: boolean;
}

const CHANNEL_NAMES: Record<string, string> = {
  whatsapp_api: 'WhatsApp (official API)', whatsapp_chat: 'WhatsApp (plain chat)', call: 'Calls',
  sms: 'SMS', email: 'Email', rcs: 'RCS',
};
const channelName = (c: string): string => CHANNEL_NAMES[c] ?? c;

const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
const rupee = (n: number): string => `₹${n >= 100 ? Math.round(n).toLocaleString('en-IN') : n.toFixed(2)}`;
const per = (cost: number, count: number): string => (count > 0 && cost > 0 ? rupee(cost / count) : '—');

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const daysAgo = (n: number): string => iso(new Date(Date.now() - n * 864e5));

export function DashboardViewTabs({ view }: { view: 'widgets' | 'roi' }): JSX.Element {
  const tab = (active: boolean): string =>
    cn('rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
      active ? 'bg-brand-600 text-white' : 'text-muted hover:bg-slate-100 dark:hover:bg-slate-800');
  return (
    <div className="mb-3 flex gap-1.5" role="tablist" aria-label="Dashboard sections">
      <Link to="/dashboard" role="tab" aria-selected={view === 'widgets'} className={tab(view === 'widgets')}>Dashboards</Link>
      <Link to="/dashboard?view=roi" role="tab" aria-selected={view === 'roi'} className={tab(view === 'roi')}>What earns money</Link>
    </div>
  );
}

export default function RoiReport(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? daysAgo(30);
  const to = params.get('to') ?? iso(new Date());
  const windowDays = params.get('window') ?? '7';
  const source = params.get('source') ?? '';
  const agentId = params.get('agent') ?? '';
  const set = (patch: Record<string, string>): void => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['roi', from, to, windowDays, source, agentId],
    queryFn: () => api.roiReport({
      // `to` is the end of the chosen day.
      from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(new Date(`${to}T00:00:00`).getTime() + 864e5).toISOString(),
      windowDays, ...(source ? { source } : {}), ...(agentId ? { agentId } : {}),
    }) as Promise<unknown> as Promise<Report>,
  });

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <Field label="From"><input type="date" className="input" value={from} max={to} onChange={(e) => set({ from: e.target.value })} /></Field>
        <Field label="To"><input type="date" className="input" value={to} min={from} onChange={(e) => set({ to: e.target.value })} /></Field>
        <div className="flex gap-1.5 pb-0.5">
          {[7, 30, 90].map((n) => (
            <button key={n} type="button" className="btn-secondary text-xs" onClick={() => set({ from: daysAgo(n), to: iso(new Date()) })}>Last {n}d</button>
          ))}
        </div>
        <Field label="Count a result within">
          <select className="input" value={windowDays} onChange={(e) => set({ window: e.target.value })}>
            {[3, 7, 14].map((n) => <option key={n} value={n}>{n} days of a touch</option>)}
          </select>
        </Field>
        <Field label="Lead source">
          <select className="input" value={source} onChange={(e) => set({ source: e.target.value })}>
            <option value="">All sources</option>
            {data?.options.sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        {data && !data.scopedToMe && (
          <Field label="Agent">
            <select className="input" value={agentId} onChange={(e) => set({ agent: e.target.value })}>
              <option value="">All agents</option>
              {data.options.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        )}
        {data && (
          <button type="button" className="btn-secondary ml-auto text-xs" onClick={() => downloadCsv(data, from, to)}>
            <Download className="mr-1 inline h-3.5 w-3.5" aria-hidden />Export CSV
          </button>
        )}
      </div>

      <p className="flex gap-2 rounded-lg bg-slate-50 p-3 text-xs text-muted dark:bg-slate-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          This shows what happened <b>after</b> we contacted someone — it does not prove the contact caused it.
          A result (a status move into a visit or a deal) is credited to the <b>last</b> message or call we made to that
          person in the {windowDays} days before it. {data?.scopedToMe ? 'You see only your own numbers. ' : ''}
          “Moved to” counts status changes recorded in the audit trail; “Now at” counts people touched in this period who are at that stage today (older
          changes made in bulk have no history).
        </span>
      </p>

      {error ? (
        <p className="card p-4 text-sm text-negative">Could not load the report: {(error as Error).message}</p>
      ) : isLoading || !data ? (
        <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-48" /></div>
      ) : data.total.touches === 0 ? (
        <p className="card p-6 text-center text-sm text-muted">Nothing was sent or called in this period{source ? ` for ${source}` : ''}. Try a longer range.</p>
      ) : (
        <>
          <Summary total={data.total} previous={data.previous} />
          {data.total.visitFixed + data.total.visitDone + data.total.won + data.total.qualified === 0 && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Low data: no status moves were recorded after a touch in this period, so visit and deal columns are mostly zero. Reply and delivery numbers are still reliable.
            </p>
          )}
          <ChannelTable rows={data.channels} />
          <TemplateTable rows={data.templates} />
          <AgentTable rows={data.agents} />
          <p className="text-2xs text-muted">
            Cost = delivered official-WhatsApp messages × rate ({rupee(data.costs.whatsappMarketing ?? 0)} marketing, {rupee(data.costs.whatsappUtility ?? 0)} utility) + provider fee. Plain chat and calls are not priced. Templates with an unknown category are left out of the cost.
          </p>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return <label className="flex flex-col gap-1 text-2xs font-medium text-muted">{label}{children}</label>;
}

function Delta({ now, before }: { now: number; before: number }): JSX.Element {
  if (before === 0 && now === 0) return <span className="text-2xs text-muted">same as before</span>;
  const diff = now - before;
  return (
    <span className={cn('text-2xs', diff > 0 ? 'text-positive' : diff < 0 ? 'text-negative' : 'text-muted')}>
      {diff > 0 ? '+' : ''}{diff} vs previous period ({before})
    </span>
  );
}

function Summary({ total, previous }: { total: Counts; previous: Counts }): JSX.Element {
  const cards: { label: string; now: number; before: number; hint?: string }[] = [
    { label: 'Touches (messages + calls)', now: total.touches, before: previous.touches },
    { label: 'Replies', now: total.replied, before: previous.replied, hint: `${pct(total.replied, total.sent)} of sent` },
    { label: 'Moved to a visit', now: total.visitFixed + total.visitDone, before: previous.visitFixed + previous.visitDone, hint: `${total.nowVisit} now at a visit stage` },
    { label: 'Moved to won', now: total.won, before: previous.won, hint: `${total.nowWon} now won` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="card p-3">
          <div className="text-2xs font-medium text-muted">{c.label}</div>
          <div className="text-2xl font-semibold tabular-nums">{c.now.toLocaleString('en-IN')}</div>
          {c.hint && <div className="text-2xs text-muted">{c.hint}</div>}
          <Delta now={c.now} before={c.before} />
        </div>
      ))}
    </div>
  );
}

const TH = 'whitespace-nowrap px-2 py-2 text-right text-2xs font-semibold text-muted first:text-left';
const TD = 'whitespace-nowrap px-2 py-2 text-right tabular-nums first:text-left';

function Table({ title, note, head, children }: { title: string; note?: string; head: [string, string?][]; children: JSX.Element[] | JSX.Element }): JSX.Element {
  return (
    <section className="card overflow-hidden">
      <div className="panel-head flex flex-wrap items-baseline gap-2 px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <span className="text-2xs text-muted">{note}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr>{head.map(([h, tip]) => <th key={h} className={TH} title={tip}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-[var(--border)]">{children}</tbody>
        </table>
      </div>
    </section>
  );
}

const FUNNEL_HEAD: [string, string][] = [
  ['Sent', 'Messages/calls handed to the provider (not queued)'],
  ['Delivered', 'Reached the phone'], ['Read', 'Opened by the customer'], ['Replied', 'Customer wrote back within the window'],
  ['Failed', 'Refused or undeliverable'], ['Qualified', 'Moved to Contacted/Qualified after a touch'],
  ['Visit fixed', 'Moved to Visit Scheduled/Fixed'], ['Visit done', 'Moved to Visit Done'], ['Won', 'Moved to Deal Won'],
  ['Cost', 'Known costs only'], ['₹ / reply', 'Cost per reply'], ['₹ / win', 'Cost per won deal'],
];

function FunnelCells({ r }: { r: Counts }): JSX.Element {
  return (
    <>
      <td className={TD}>{r.sent}</td>
      <td className={TD}>{r.delivered} <span className="text-muted">{pct(r.delivered, r.sent)}</span></td>
      <td className={TD}>{r.read} <span className="text-muted">{pct(r.read, r.delivered)}</span></td>
      <td className={TD}>{r.replied} <span className="text-muted">{pct(r.replied, r.sent)}</span></td>
      <td className={cn(TD, r.failed > 0 && 'text-negative')}>{r.failed}</td>
      <td className={TD}>{r.qualified}</td><td className={TD}>{r.visitFixed}</td><td className={TD}>{r.visitDone}</td><td className={TD}>{r.won}</td>
      <td className={TD}>{r.cost > 0 ? rupee(r.cost) : '—'}</td>
      <td className={TD}>{per(r.cost, r.replied)}</td><td className={TD}>{per(r.cost, r.won)}</td>
    </>
  );
}

function ChannelTable({ rows }: { rows: ChannelRow[] }): JSX.Element {
  return (
    <Table title="By channel" note="Calls: “Delivered” is not used — see Answered"
      head={[['Channel'], ...FUNNEL_HEAD, ['Answered', 'Calls picked up']]}>
      {rows.map((r) => (
        <tr key={r.channel}>
          <td className={TD}>
            <div className="font-medium">{channelName(r.channel)}</div>
            {r.topFailures.length > 0 && <div className="max-w-[16rem] truncate text-2xs text-negative" title={r.topFailures.map((f) => `${f.reason}: ${f.count}`).join('\n')}>
              {r.topFailures.map((f) => `${f.reason} ×${f.count}`).join(' · ')}</div>}
          </td>
          <FunnelCells r={r} />
          <td className={TD}>{r.channel === 'call' ? `${r.answered} ${pct(r.answered, r.sent)}` : '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

function TemplateTable({ rows }: { rows: TemplateRow[] }): JSX.Element {
  const { best, worst } = useMemo(() => {
    const ranked = rows.filter((r) => r.sent >= 20).sort((a, b) => b.replied / b.sent - a.replied / a.sent);
    return { best: ranked[0]?.template, worst: ranked.length > 1 ? ranked[ranked.length - 1]?.template : undefined };
  }, [rows]);
  if (rows.length === 0) return <p className="card p-4 text-xs text-muted">No template messages in this period.</p>;
  return (
    <Table title="By template" note="Best / worst by reply rate (templates with 20+ sends)"
      head={[['Template'], ['Type', 'Marketing or utility (from the name or Meta)'], ['Failure rate', 'Failed ÷ attempted'], ...FUNNEL_HEAD]}>
      {rows.map((r) => (
        <tr key={r.template} className={cn(r.template === best && 'bg-green-50/60 dark:bg-green-950/20', r.template === worst && 'bg-red-50/60 dark:bg-red-950/20')}>
          <td className={TD}>
            <div className="max-w-[18rem] truncate font-medium" title={r.template}>{r.template}</div>
            {r.template === best && <span className="text-2xs text-positive">best reply rate</span>}
            {r.template === worst && <span className="text-2xs text-negative">worst reply rate</span>}
            {r.topFailures[0] && <div className="max-w-[18rem] truncate text-2xs text-negative">{r.topFailures[0].reason} ×{r.topFailures[0].count}</div>}
          </td>
          <td className={TD}>{r.category}</td>
          <td className={cn(TD, r.failed / Math.max(r.touches, 1) > 0.3 && 'text-negative')}>{pct(r.failed, r.touches)}</td>
          <FunnelCells r={r} />
        </tr>
      ))}
    </Table>
  );
}

function AgentTable({ rows }: { rows: AgentRow[] }): JSX.Element {
  return (
    <Table title="By agent" note="A message counts for the person who sent it, else the number's owner, else the contact's owner"
      head={[['Agent'], ['Leads worked'], ['Messages', 'Outbound messages'], ['Calls'], ['Answered'], ['Replies'], ['Visits', 'Moved to a visit'], ['Won'],
        ['Reply time', 'Median minutes to answer a customer message']]}>
      {rows.map((r) => {
        return (
          <tr key={r.agentId ?? 'none'}>
            <td className={cn(TD, 'font-medium')}>{r.agent}</td>
            <td className={TD}>{r.leads}</td>
            <td className={TD}>{r.messages}</td>
            <td className={TD}>{r.calls}</td>
            <td className={TD}>{r.answered}</td>
            <td className={TD}>{r.replied}</td>
            <td className={TD}>{r.visitFixed + r.visitDone}</td>
            <td className={TD}>{r.won}</td>
            <td className={TD}>{r.medianResponseMinutes === null ? '—' : r.medianResponseMinutes < 90 ? `${r.medianResponseMinutes} min` : `${(r.medianResponseMinutes / 60).toFixed(1)} h`}</td>
          </tr>
        );
      })}
    </Table>
  );
}

function downloadCsv(d: Report, from: string, to: string): void {
  const esc = (v: unknown): string => {
    const s = String(v ?? '');
    // A leading = + - @ would run as a formula in Excel.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const cols: (keyof Counts)[] = ['touches', 'sent', 'delivered', 'read', 'replied', 'failed', 'qualified', 'visitFixed', 'visitDone', 'won', 'cost'];
  const lines = [['kind', 'name', 'category', ...cols].join(',')];
  for (const r of d.channels) lines.push(['channel', channelName(r.channel), '', ...cols.map((c) => r[c])].map(esc).join(','));
  for (const r of d.templates) lines.push(['template', r.template, r.category, ...cols.map((c) => r[c])].map(esc).join(','));
  for (const r of d.agents) lines.push(['agent', r.agent, '', ...cols.map((c) => r[c])].map(esc).join(','));
  const blob = new Blob(['﻿', lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `what-earns-money_${from}_${to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
