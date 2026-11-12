import { type JSX, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Play } from 'lucide-react';
import { api, type AiCallOnRecord } from '../lib/api';

/**
 * Every call the AI agent made to this record: when, how long, how it went, a one-line summary, the recording and
 * transcript, which agent made it, and what the call wrote back onto the record.
 *
 * Shown at the top of the record's Calls tab, in the record page and the split view alike. A record the agent has
 * never called shows nothing at all, so Inventories without a Seller agent never see an empty box.
 */
export const AI_STATUS_LABEL: Record<string, string> = {
  never_called: 'Never called', queued: 'Queued', ringing: 'Ringing', answered: 'Answered', no_answer: 'No answer', busy: 'Busy',
  voicemail: 'Voicemail', not_interested: 'Not interested', callback: 'Callback requested', interested: 'Interested',
  do_not_call: 'Do not call', failed: 'Failed', wrong_number: 'Wrong number',
};
const GOOD = new Set(['interested', 'callback', 'answered']);
const BAD = new Set(['failed', 'do_not_call', 'wrong_number']);

export function AiCallsPanel({ module, recordId }: { module: string; recordId: string }): JSX.Element | null {
  const { data } = useQuery({ queryKey: ['ai-calls', recordId], queryFn: () => api.aiCallsOnRecord(module, recordId), refetchInterval: 20_000 });
  if (!data?.calls.length) return null;
  return (
    <section className="card space-y-3 p-4" data-testid="ai-calls-panel" aria-label="AI calls">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Bot className="h-4 w-4 text-brand-600" aria-hidden /> AI calls ({data.calls.length})</h2>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {data.calls.map((call) => <AiCallRow key={call.id} call={call} />)}
      </ul>
    </section>
  );
}

function AiCallRow({ call }: { call: AiCallOnRecord }): JSX.Element {
  const [playing, setPlaying] = useState(false);
  const [words, setWords] = useState(false);
  const tone = GOOD.has(call.ai_status) ? 'bg-emerald-100 text-emerald-800' : BAD.has(call.ai_status) ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700';
  const minutes = call.duration_seconds >= 60 ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s` : `${call.duration_seconds}s`;
  return (
    <li className="space-y-1.5 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{new Date(call.started_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{AI_STATUS_LABEL[call.ai_status] ?? call.ai_status}</span>
        <span className="text-muted">{minutes}</span>
        {call.disposition && <span className="text-muted">· {call.disposition}</span>}
        <span className="ml-auto text-muted">{call.automatic ? 'Automatic' : 'Started by a person'}{call.agent_app_id ? ` · agent ${call.agent_app_id.slice(0, 8)}` : ''}</span>
      </div>
      {call.ai_summary && <p>{call.ai_summary}</p>}
      {call.feedback && <p className="whitespace-pre-line rounded bg-slate-50 p-2 text-muted dark:bg-slate-800/40"><strong>Written to the record:</strong> {call.feedback.replace(/^Sarvam AI call feedback\n?/, '')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {call.has_recording && (playing
          ? <audio src={api.recordingUrl(call.id)} controls autoPlay className="h-8 w-64" />
          : <button className="btn-secondary btn-sm" onClick={() => setPlaying(true)}><Play className="h-3.5 w-3.5" /> Recording</button>)}
        {call.transcript && <button className="btn-secondary btn-sm" aria-expanded={words} onClick={() => setWords(!words)}>{words ? 'Hide' : 'Show'} transcript</button>}
      </div>
      {words && call.transcript && <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] dark:bg-slate-800/40">{call.transcript}</pre>}
    </li>
  );
}
