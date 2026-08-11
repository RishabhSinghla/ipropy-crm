/**
 * The evening review — the other half of speaking at the gate.
 *
 * Without this screen, a voice note is data nobody sees. With it, the day's
 * work is: read a line, glance at the values, tap Confirm. Ten properties in
 * about two minutes, sitting down, instead of ninety field entries standing in
 * the sun.
 *
 * The design rule is that **everything is already ticked**. Reviewing means
 * un-ticking the one that is wrong, not confirming the nine that are right —
 * a screen that demands nine confirmations per property to save four is not a
 * saving, and it is the failure mode this whole feature was meant to avoid.
 *
 * The other rule: show what was heard. A value on its own gives a reviewer no
 * way to tell a good decode from a plausible-sounding bad one. "3.25 cr" next
 * to ₹3.25 Cr is checkable at a glance; ₹3.25 Cr alone is not.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Clock, Mic, Volume2 } from 'lucide-react';
import { api, authedFileUrl, type CaptureSessionDetail, type CaptureSessionRow } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { FieldInput } from '../components/FieldRenderer';
import { EmptyState, Skeleton, Spinner } from '../components/ui';

export default function CaptureReviewPage(): JSX.Element {
  const { data: sessions, isLoading } = useQuery({
    queryKey: ['capture', 'sessions', 'review'],
    queryFn: () => api.captureSessions(50),
    retry: false,
  });

  // A visit is worth reviewing once it has stopped collecting photos and has
  // something to say. One still in progress is not finished being a visit.
  const pending = useMemo(
    () => (sessions ?? []).filter((s) => s.status === 'ready' && (s.transcript || s.voiceStatus !== 'none')),
    [sessions],
  );
  const reviewed = useMemo(() => (sessions ?? []).filter((s) => s.status === 'reviewed'), [sessions]);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">Review today&apos;s visits</h1>
        <p className="text-sm text-muted">
          What you said at each gate, turned into details. Untick anything wrong, then confirm.
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : !pending.length ? (
        <EmptyState
          icon={<Check className="h-8 w-8" />}
          title="Nothing waiting"
          body={reviewed.length ? 'Everything from today has been confirmed.' : 'Visits with a voice note will appear here once they finish.'}
        />
      ) : (
        <div className="space-y-4">
          {pending.map((session) => <ReviewCard key={session.id} summary={session} />)}
        </div>
      )}

      {reviewed.length ? (
        <section className="space-y-2 pt-4">
          <h2 className="text-sm font-semibold text-muted">Already confirmed</h2>
          <ul className="card divide-y divide-slate-100 dark:divide-slate-800">
            {reviewed.slice(0, 10).map((s) => (
              <li key={s.id}>
                <Link
                  to={s.recordId ? `/properties/${s.recordId}` : '#'}
                  className="flex items-center gap-2 p-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span className="flex-1 truncate">{s.recordLabel ?? 'Unassigned visit'}</span>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ReviewCard({ summary }: { summary: CaptureSessionRow }): JSX.Element {
  const queryClient = useQueryClient();
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [rejected, setRejected] = useState<Set<string>>(new Set());

  const { data: detail, isLoading } = useQuery({
    queryKey: ['capture', 'session', summary.id],
    queryFn: () => api.captureSession(summary.id),
    retry: false,
  });

  const confirm = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.reviewCaptureSession(summary.id, values),
    onSuccess: (_, values) => {
      const n = Object.keys(values).length;
      toast.success(
        summary.recordLabel ?? 'Visit confirmed',
        n ? `${n} detail${n === 1 ? '' : 's'} saved` : 'Marked as reviewed',
      );
      void queryClient.invalidateQueries({ queryKey: ['capture'] });
    },
    onError: (err) => toast.error('Could not save', (err as Error).message),
  });

  const suggestions = detail?.suggestions ?? [];
  // Only rows that would actually change something are offered. A suggestion
  // that matches the record is not a decision worth asking somebody to make.
  const actionable = suggestions.filter((s) => s.changes);

  const accepted = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const s of actionable) {
      if (rejected.has(s.field)) continue;
      out[s.field] = s.field in edited ? edited[s.field] : s.value;
    }
    return out;
  };

  const toggle = (field: string): void => setRejected((prev) => {
    const next = new Set(prev);
    if (next.has(field)) next.delete(field); else next.add(field);
    return next;
  });

  return (
    <article className="card space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium">
            {summary.recordId ? (
              <Link to={`/properties/${summary.recordId}`} className="hover:underline">
                {summary.recordLabel ?? 'Unassigned visit'}
              </Link>
            ) : (summary.recordLabel ?? 'Unassigned visit')}
          </h2>
          <p className="text-xs text-muted">
            {new Date(summary.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {' · '}{summary.mediaCount} file{summary.mediaCount === 1 ? '' : 's'}
          </p>
        </div>
        {detail?.voiceUrl ? (
          // Playable here, not only on the record: the whole reason to doubt a
          // value is to listen to the sentence it came from.
          <audio controls src={authedFileUrl(detail.voiceUrl)} className="h-8 w-44 shrink-0" />
        ) : null}
      </div>

      {isLoading ? <Skeleton className="h-20" /> : (
        <>
          {detail?.transcript ? (
            <p className="rounded-lg bg-slate-50 p-3 text-sm italic text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
              <Volume2 className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-slate-400" />
              {detail.transcript}
            </p>
          ) : summary.voiceStatus === 'pending' ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Clock className="h-3.5 w-3.5" />
              Recorded — waiting to be written out.
            </p>
          ) : summary.voiceStatus === 'failed' ? (
            <p className="text-sm text-muted">
              This recording could not be written out. It is still saved above — you can play it and type the details in.
            </p>
          ) : null}

          {actionable.length ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {actionable.map((s) => {
                const off = rejected.has(s.field);
                return (
                  <li key={s.field} className="flex items-start gap-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={!off}
                      onChange={() => toggle(s.field)}
                      aria-label={`Use ${s.label}`}
                      className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 dark:border-slate-600"
                    />
                    <div className={cn('min-w-0 flex-1', off && 'opacity-40')}>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-xs font-medium text-muted">{s.label}</span>
                        {s.heard ? <span className="text-xs italic text-slate-400">heard &ldquo;{s.heard}&rdquo;</span> : null}
                      </div>
                      {detail?.fields?.[s.field] ? (
                        <FieldInput
                          field={detail.fields[s.field]}
                          value={s.field in edited ? edited[s.field] : s.value}
                          onChange={(v) => setEdited((prev) => ({ ...prev, [s.field]: v }))}
                          disabled={off}
                        />
                      ) : (
                        <p className="text-sm">{s.formatted}</p>
                      )}
                      {s.currentFormatted ? (
                        <p className="mt-0.5 text-xs text-muted">now: {s.currentFormatted}</p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : detail?.transcript ? (
            <p className="text-sm text-muted">Nothing new to add — the details already match.</p>
          ) : null}

          {detail?.unmatched?.length ? (
            <p className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <Mic className="mr-1 inline h-3 w-3 align-[-1px]" />
              Also said, with nowhere to put it: {detail.unmatched.join('; ')}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => confirm.mutate(accepted())}
            disabled={confirm.isPending}
            className="btn-primary flex w-full items-center justify-center gap-2 py-3"
          >
            {confirm.isPending ? <Spinner /> : <Check className="h-4 w-4" />}
            {actionable.length && rejected.size < actionable.length
              ? `Confirm ${actionable.length - rejected.size} detail${actionable.length - rejected.size === 1 ? '' : 's'}`
              : 'Mark as done'}
          </button>
        </>
      )}
    </article>
  );
}
