import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ListResult } from '@ipropy/shared';
import { Send, Sparkles, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { cn, renderMarkdown } from '../lib/utils';
import { Badge, Spinner } from './ui';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  results?: ListResult;
  module?: string;
}

const SUGGESTIONS = [
  'Which leads should I call today?',
  'Show me available 3 BHK units under 2 Cr',
  'Which deals are at risk this month?',
  'How many site visits happened last week?',
  'Leads from Facebook that never got contacted',
];

export default function AiAssistant({
  open, onClose,
}: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { aiAvailable } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  const send = async (question: string): Promise<void> => {
    if (!question.trim() || busy) return;
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setInput('');
    setBusy(true);
    try {
      const result = await api.askAi(question);
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: result.answer,
        results: result.results,
        module: (result.query as { module?: string } | undefined)?.module,
      }]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: `Sorry — that failed: ${(err as Error).message}`,
      }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg animate-slide-up flex-col border-l border-slate-200 bg-white shadow-float dark:border-slate-800 dark:bg-slate-900">
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-100 dark:bg-brand-950">
            <Sparkles className="h-4 w-4 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold">Ask iPropy</p>
            <p className="text-2xs text-muted">
              {aiAvailable ? 'Ask about your pipeline, leads or inventory' : 'Requires an AI provider'}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                I can query your CRM directly. Every answer runs a real, permission-scoped query —
                so the numbers are the same ones you'd get from a list view.
              </p>
              <div className="space-y-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm transition-colors hover:border-brand-300 hover:bg-brand-50 dark:border-slate-700 text-muted dark:hover:border-brand-800 dark:hover:bg-brand-950/40"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'max-w-[90%] rounded-xl px-3.5 py-2.5',
                msg.role === 'user'
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800',
              )}>
                {msg.role === 'user' ? (
                  <p className="text-sm">{msg.content}</p>
                ) : (
                  <>
                    <div className="prose-ai" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                    {msg.results && msg.results.rows.length > 0 && msg.module && (
                      <div className="mt-3 space-y-1 border-t border-slate-200 pt-2 dark:border-slate-700">
                        <div className="flex items-center justify-between">
                          <p className="text-2xs font-medium uppercase tracking-wide text-muted">
                            {msg.results.total} result{msg.results.total === 1 ? '' : 's'}
                          </p>
                          <Link
                            to={`/${msg.module}`}
                            onClick={onClose}
                            className="text-2xs text-brand-600 hover:underline dark:text-brand-400"
                          >
                            Open module
                          </Link>
                        </div>
                        {msg.results.rows.slice(0, 8).map((row) => (
                          <Link
                            key={row.id}
                            to={`/${msg.module}/${row.id}`}
                            onClick={onClose}
                            className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-white dark:hover:bg-slate-700"
                          >
                            <span className="truncate font-medium text-slate-700 dark:text-slate-200">{row.label}</span>
                            {typeof row.values.ai_score === 'number' && (
                              <Badge color={Number(row.values.ai_score) >= 70 ? '#22c55e' : '#94a3b8'}>
                                {String(row.values.ai_score)}
                              </Badge>
                            )}
                          </Link>
                        ))}
                        {msg.results.total > 8 && (
                          <p className="px-2 text-2xs text-muted">…and {msg.results.total - 8} more</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Thinking…
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <form
          className="shrink-0 border-t border-slate-200 p-3 dark:border-slate-800"
          onSubmit={(e) => { e.preventDefault(); void send(input); }}
        >
          <div className="flex gap-2">
            <input
              ref={inputRef}
              className="input"
              placeholder="Ask anything about your CRM…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
            />
            <button type="submit" className="btn-primary px-3" disabled={busy || !input.trim()}>
              <Send className="h-4 w-4" />
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
