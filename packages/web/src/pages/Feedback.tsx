/**
 * "Meri Reports" — the reporter's side of the AI engineering pipeline.
 *
 * Everything a submitted report does afterwards is visible here in the same
 * Hinglish it was written in: the AI's understanding of the request, the
 * timeline of the agent's work, the pull request, and — once the fix deploys —
 * one-tap verification. "Done" closes the loop; "Abhi theek nahi hai" sends
 * the agent back with the follow-up, on the same ticket.
 *
 * The list is simple on purpose: cards, newest first, each expandable to its
 * story. No jargon reaches this page: no "issue", no "PR", no "branch".
 */
import { type JSX, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, ExternalLink, Loader2, MessageSquarePlus, RotateCcw, XCircle } from 'lucide-react';
import { api, type FeedbackItem } from '../lib/api';
import { toast } from '../lib/store';
import { Modal, Spinner } from '../components/ui';
import { authedFileUrl } from '../lib/api';

const STATUS_LABELS: Record<FeedbackItem['status'], { label: string; tone: string }> = {
  submitted: { label: 'Mil gayi — line mein hai', tone: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  triaging: { label: 'AI samajh raha hai', tone: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300' },
  working: { label: 'AI kaam kar raha hai', tone: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300' },
  reviewing: { label: 'Tests ho rahe hain', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  fixed: { label: 'Ho gaya — check karein!', tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  reopened: { label: 'Dobara dekh raha hai', tone: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300' },
  failed: { label: 'Nahi ban paayi', tone: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
  declined: { label: 'Band ho gayi', tone: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
};

const STAGE_ICONS: Record<string, string> = {
  submitted: '📝', triaging: '🤔', working: '🔧', reviewing: '🧪',
  fixed: '✅', reopened: '🔁', failed: '❌', declined: '📁',
};

export default function FeedbackPage(): JSX.Element {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['feedback'],
    queryFn: api.feedbackList,
    // The poller moves things forward server-side every minute; polling here
    // keeps the page honest without a socket event for it (yet).
    refetchInterval: 60_000,
  });

  const [expanded, setExpanded] = useState<string | null>(null);
  const [verifyOpen, setVerifyOpen] = useState<FeedbackItem | null>(null);
  const [followUp, setFollowUp] = useState('');
  const [busy, setBusy] = useState(false);

  const verify = async (item: FeedbackItem, ok: boolean): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.verifyFeedback(item.id, ok, ok ? undefined : followUp.trim() || undefined);
      toast.success(res.message);
      setVerifyOpen(null);
      setFollowUp('');
      void qc.invalidateQueries({ queryKey: ['feedback'] });
    } catch (err) {
      toast.error('Nahi ho paaya', err instanceof Error ? err.message : 'Dobara try karein.');
    } finally {
      setBusy(false);
    }
  };

  const addNote = async (item: FeedbackItem): Promise<void> => {
    const text = window.prompt('Kuch aur batana hai is report ke baare mein?');
    if (!text?.trim()) return;
    try {
      await api.feedbackNote(item.id, text.trim());
      toast.success('Note add ho gaya — AI engineer ko dikhega.');
      void qc.invalidateQueries({ queryKey: ['feedback'] });
    } catch (err) {
      toast.error('Nahi bana', err instanceof Error ? err.message : 'Dobara try karein.');
    }
  };

  if (list.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-brand-600" />
      </div>
    );
  }

  const items = list.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Meri Reports</h1>
          <p className="text-sm text-muted">Jo aapne bataya tha, wo kahan pahuncha hai.</p>
        </div>
      </div>

      {items.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center dark:border-slate-700">
          <p className="text-sm font-medium">Abhi koi report nahi hai</p>
          <p className="mt-1 text-sm text-muted">
            Kahin bhi <strong>🐞 Report</strong> button dabayein aur batayein ki kya theek karna hai.
          </p>
        </div>
      )}

      {items.map((item) => {
        const status = STATUS_LABELS[item.status];
        const isOpen = expanded === item.id;
        return (
          <article
            key={item.id}
            className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <button
              onClick={() => setExpanded(isOpen ? null : item.id)}
              className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
              aria-expanded={isOpen}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>
                    {status.label}
                  </span>
                  <span className="text-xs text-muted">
                    {new Date(item.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    {' · '}
                    {item.kind === 'bug' ? 'Gadbad' : item.kind === 'idea' ? 'Idea' : 'Sawaal'}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm">{item.text}</p>
              </div>
              <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
              <div className="space-y-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
                {item.ai_summary && (
                  <div className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900 dark:bg-brand-950 dark:text-brand-100">
                    <p className="mb-0.5 text-xs font-semibold uppercase tracking-wide opacity-70">AI ne aapki baat aise samjhi</p>
                    {item.ai_summary}
                  </div>
                )}

                {item.events && item.events.length > 0 && (
                  <ol className="space-y-1.5">
                    {item.events.map((e, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <span aria-hidden>{STAGE_ICONS[e.stage] ?? '•'}</span>
                        <div>
                          <span>{e.note}</span>
                          <span className="ml-1.5 text-xs text-muted">{e.at}</span>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {item.screenshots && item.screenshots.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {item.screenshots.map((s) => (
                      <a key={s.id} href={authedFileUrl(`/api/files/${s.id}`)} target="_blank" rel="noreferrer">
                        <img
                          src={authedFileUrl(`/api/files/${s.id}`)}
                          alt={s.name}
                          className="h-16 w-24 rounded-md border border-slate-200 object-cover dark:border-slate-700"
                        />
                      </a>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {item.status === 'fixed' && (
                    <>
                      <button onClick={() => setVerifyOpen(item)} className="btn-primary gap-1.5 text-xs">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Check karke batayein
                      </button>
                    </>
                  )}
                  {item.status === 'reopened' && (
                    <span className="text-xs text-orange-600 dark:text-orange-400">
                      Aapne bataya tha ki abhi theek nahi hai — AI dobara kar raha hai.
                    </span>
                  )}
                  <button onClick={() => void addNote(item)} className="btn-ghost gap-1.5 text-xs">
                    <MessageSquarePlus className="h-3.5 w-3.5" /> Kuch aur batayein
                  </button>
                  {item.pr_url && (
                    <a href={item.pr_url} target="_blank" rel="noreferrer" className="btn-ghost gap-1 text-xs text-muted">
                      <ExternalLink className="h-3.5 w-3.5" /> Code dekhein
                    </a>
                  )}
                </div>
              </div>
            )}
          </article>
        );
      })}

      {verifyOpen && (
        <Modal open onClose={() => setVerifyOpen(null)} title="Ho gaya?" size="sm">
          <div className="space-y-4 px-5 py-4">
            <p className="text-sm">
              Jo aapne bataya tha — <em>{verifyOpen.text}</em> — wo ab live hai. Kaise laga?
            </p>
            <div>
              <label htmlFor="follow-up" className="mb-1 block text-sm font-medium">
                Agar abhi theek nahi hai, to kya dikkat hai?
              </label>
              <textarea
                id="follow-up"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                rows={2}
                placeholder="Jaise: 'Locality aa gayi, par sector nahi aaya.'"
                className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3.5 dark:border-slate-800">
            <button onClick={() => void verify(verifyOpen, true)} disabled={busy} className="btn-primary gap-1.5">
              {busy ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />} Ho gaya, shaandaar!
            </button>
            <button
              onClick={() => void verify(verifyOpen, false)}
              disabled={busy || !followUp.trim()}
              className="btn-ghost gap-1.5 text-red-600 dark:text-red-400"
              title={followUp.trim() ? undefined : 'Pehle bataayein kya dikkat hai'}
            >
              <RotateCcw className="h-4 w-4" /> Abhi theek nahi hai
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
