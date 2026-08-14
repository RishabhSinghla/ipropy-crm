import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Brain, Check, Clock3, History, Menu, Mic, Plus, Send, Sparkles, Square,
  Trash2, X,
} from 'lucide-react';
import type {
  AiAssistantAction, AiAssistantMessage, AiMemory, AiThreadSummary,
} from '../lib/api';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn, renderMarkdown } from '../lib/utils';
import { Badge, Spinner } from './ui';
import { PeekLink } from './PeekLink';

const SUGGESTIONS = [
  'Which leads should I call today?',
  'Show me available 3 BHK properties under 2 Cr',
  'Which follow-ups are overdue?',
  'Which properties have the most active buyer matches?',
  'Summarise what needs my attention today',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function valueLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ActionCard({
  action, busy, onConfirm, onCancel,
}: {
  action: AiAssistantAction;
  busy: boolean;
  onConfirm: (action: AiAssistantAction) => void;
  onCancel: (action: AiAssistantAction) => void;
}): JSX.Element {
  const pending = action.status === 'pending';
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="border-b border-amber-200 px-3 py-2 dark:border-amber-900">
        <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">CRM change to review</p>
        <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">{action.summary}</p>
      </div>
      <div className="space-y-1.5 px-3 py-2">
        {action.changes.map((change) => (
          <div key={change.field} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-xs">
            <span className="truncate text-slate-500 line-through dark:text-slate-400">{valueLabel(change.from)}</span>
            <span className="text-slate-400">→</span>
            <span className="truncate font-medium text-slate-800 dark:text-slate-100">{change.label}: {valueLabel(change.to)}</span>
          </div>
        ))}
      </div>
      {pending ? (
        <div className="flex gap-2 border-t border-amber-200 px-3 py-2 dark:border-amber-900">
          <button className="btn-primary btn-sm flex-1" disabled={busy} onClick={() => onConfirm(action)}>
            {busy ? <Spinner className="h-3 w-3" /> : <Check className="h-3.5 w-3.5" />} Confirm change
          </button>
          <button className="btn-secondary btn-sm" disabled={busy} onClick={() => onCancel(action)}>Cancel</button>
        </div>
      ) : (
        <div className="border-t border-amber-200 px-3 py-2 text-xs font-medium capitalize text-amber-800 dark:border-amber-900 dark:text-amber-300">
          {action.status === 'confirmed' ? '✓ Change completed' : `${action.status} — no change made`}
        </div>
      )}
    </div>
  );
}

export default function AiAssistant({
  open, onClose,
}: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { aiAvailable } = useApp();
  const location = useLocation();
  const [messages, setMessages] = useState<AiAssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<AiThreadSummary[]>([]);
  const [memories, setMemories] = useState<AiMemory[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyMode, setHistoryMode] = useState<'chats' | 'memory'>('chats');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const recordContext = useMemo(() => {
    const [module, id] = location.pathname.split('/').filter(Boolean);
    return module && id && UUID.test(id) ? { contextModule: module, contextRecordId: id } : {};
  }, [location.pathname]);

  const refreshThreads = useCallback(async (): Promise<void> => {
    const rows = await api.aiThreads();
    setThreads(rows);
  }, []);

  const refreshMemories = useCallback(async (): Promise<void> => {
    setMemories(await api.aiMemories());
  }, []);

  const loadThread = useCallback(async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const thread = await api.aiThread(id);
      setActiveThreadId(thread.id);
      setMessages(thread.messages ?? []);
      setHistoryOpen(false);
    } catch (err) {
      toast.error('Could not open that chat', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void Promise.all([refreshThreads(), refreshMemories()]).catch(() => undefined);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, refreshMemories, refreshThreads]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy, actionBusy]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const newConversation = (): void => {
    setActiveThreadId(null);
    setMessages([]);
    setInput('');
    setHistoryOpen(false);
    setTimeout(() => inputRef.current?.focus(), 20);
  };

  const send = async (question: string): Promise<void> => {
    const clean = question.trim();
    if (!clean || busy) return;
    setMessages((previous) => [...previous, { role: 'user', content: clean, at: new Date().toISOString() }]);
    setInput('');
    setBusy(true);
    try {
      const result = await api.askAi(clean, {
        ...(activeThreadId ? { threadId: activeThreadId } : recordContext),
      });
      setActiveThreadId(result.threadId);
      setMessages((previous) => [...previous, {
        role: 'assistant',
        content: result.answer,
        query: result.query,
        results: result.results,
        action: result.action,
        choices: result.choices,
        at: new Date().toISOString(),
      }]);
      await refreshThreads();
      if (result.remembered) await refreshMemories();
    } catch (err) {
      setMessages((previous) => [...previous, {
        role: 'assistant',
        content: `Sorry — that failed: ${(err as Error).message}`,
        at: new Date().toISOString(),
      }]);
    } finally {
      setBusy(false);
    }
  };

  const confirmAction = async (action: AiAssistantAction): Promise<void> => {
    setActionBusy(action.id);
    try {
      const result = await api.confirmAiAction(action.id);
      setActiveThreadId(result.threadId);
      await loadThread(result.threadId);
      await refreshThreads();
      toast.success('CRM updated', result.action.summary);
    } catch (err) {
      toast.error('Could not complete that change', (err as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  const cancelAction = async (action: AiAssistantAction): Promise<void> => {
    setActionBusy(action.id);
    try {
      const result = await api.cancelAiAction(action.id);
      if (activeThreadId) await loadThread(activeThreadId);
      else {
        setMessages((previous) => previous.map((message) => message.action?.id === action.id
          ? { ...message, action: result.action }
          : message));
      }
      toast.info('Change cancelled', 'No CRM data was changed.');
    } catch (err) {
      toast.error('Could not cancel that change', (err as Error).message);
    } finally {
      setActionBusy(null);
    }
  };

  const deleteThread = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this Ask iPropy conversation?')) return;
    try {
      await api.deleteAiThread(id);
      if (activeThreadId === id) newConversation();
      await refreshThreads();
    } catch (err) {
      toast.error('Could not delete chat', (err as Error).message);
    }
  };

  const deleteMemory = async (id: string): Promise<void> => {
    try {
      await api.deleteAiMemory(id);
      await refreshMemories();
      toast.info('Memory removed');
    } catch (err) {
      toast.error('Could not remove memory', (err as Error).message);
    }
  };

  const stopRecording = (): void => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  const startRecording = async (): Promise<void> => {
    if (recording) { stopRecording(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error('Voice input is not supported by this browser');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const preferred = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        setTranscribing(true);
        void api.transcribeAiAudio(audio)
          .then(({ transcript }) => {
            setInput((current) => current ? `${current.trim()} ${transcript}` : transcript);
            setTimeout(() => inputRef.current?.focus(), 20);
          })
          .catch((err: Error) => toast.error('Could not transcribe voice', err.message))
          .finally(() => setTranscribing(false));
      };
      recorder.start();
      setRecording(true);
    } catch (err) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      toast.error('Microphone unavailable', (err as Error).message);
    }
  };

  if (!open) return null;

  return (
    <>
      <button aria-label="Close Ask iPropy" className="fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[1px] sm:hidden" onClick={onClose} />
      <aside className="fixed inset-x-2 bottom-2 top-14 z-50 flex animate-slide-up flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-float sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-16 sm:w-[min(30rem,calc(100vw-2rem))] dark:border-slate-700 dark:bg-slate-900">
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-100 dark:bg-brand-950">
            <Sparkles className="h-4 w-4 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Ask iPropy</p>
            <p className="truncate text-2xs text-muted">
              {recordContext.contextRecordId && !activeThreadId
                ? `Ready to help with this ${recordContext.contextModule?.replace(/_/g, ' ')}`
                : aiAvailable ? 'Your CRM assistant' : 'Connect an AI provider in Admin'}
            </p>
          </div>
          <button onClick={newConversation} className="btn-ghost p-1.5" title="New chat"><Plus className="h-4 w-4" /></button>
          <button onClick={() => setHistoryOpen((value) => !value)} className={cn('btn-ghost p-1.5', historyOpen && 'bg-slate-100 dark:bg-slate-800')} title="Chat history and memory">
            <History className="h-4 w-4" />
          </button>
          <button onClick={onClose} className="btn-ghost p-1.5" title="Close"><X className="h-4 w-4" /></button>
        </header>

        {historyOpen && (
          <div className="absolute inset-x-0 bottom-0 top-[53px] z-20 flex flex-col bg-white dark:bg-slate-900">
            <div className="flex border-b border-slate-200 px-3 pt-2 dark:border-slate-800">
              <button onClick={() => setHistoryMode('chats')} className={cn('border-b-2 px-3 py-2 text-xs font-medium', historyMode === 'chats' ? 'border-brand-500 text-brand-600' : 'border-transparent text-muted')}>
                <Menu className="mr-1.5 inline h-3.5 w-3.5" /> Chats
              </button>
              <button onClick={() => setHistoryMode('memory')} className={cn('border-b-2 px-3 py-2 text-xs font-medium', historyMode === 'memory' ? 'border-brand-500 text-brand-600' : 'border-transparent text-muted')}>
                <Brain className="mr-1.5 inline h-3.5 w-3.5" /> Memory
              </button>
              <button onClick={() => setHistoryOpen(false)} className="btn-ghost ml-auto mb-1 p-1.5"><X className="h-4 w-4" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {historyMode === 'chats' ? (
                <div className="space-y-1.5">
                  <button onClick={newConversation} className="btn-secondary mb-2 w-full justify-start"><Plus className="h-4 w-4" /> New conversation</button>
                  {!threads.length && <p className="p-4 text-center text-xs text-muted">Your previous chats will appear here.</p>}
                  {threads.map((thread) => (
                    <div key={thread.id} className={cn('group flex items-start gap-1 rounded-lg border p-1.5', activeThreadId === thread.id ? 'border-brand-300 bg-brand-50 dark:border-brand-800 dark:bg-brand-950/40' : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800')}>
                      <button className="min-w-0 flex-1 px-1.5 py-1 text-left" onClick={() => void loadThread(thread.id)}>
                        <p className="truncate text-xs font-medium">{thread.title}</p>
                        <p className="mt-0.5 truncate text-2xs text-muted">{thread.preview || `${thread.messageCount} messages`}</p>
                        <p className="mt-1 flex items-center gap-1 text-[10px] text-slate-400"><Clock3 className="h-2.5 w-2.5" /> {new Date(thread.updatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                      </button>
                      <button onClick={() => void deleteThread(thread.id)} className="btn-ghost mt-1 p-1.5 text-slate-400 opacity-0 group-hover:opacity-100" title="Delete chat"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="rounded-lg bg-slate-50 p-3 text-xs text-muted dark:bg-slate-800">
                    Memory is explicit and private to your login. Say “Remember that I prefer…” in a chat. Ask iPropy does not silently save every message.
                  </p>
                  {!memories.length && <p className="p-4 text-center text-xs text-muted">No saved preferences yet.</p>}
                  {memories.map((memory) => (
                    <div key={memory.id} className="group flex gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                      <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
                      <p className="min-w-0 flex-1 text-xs">{memory.fact}</p>
                      <button onClick={() => void deleteMemory(memory.id)} className="btn-ghost p-1 text-slate-400 opacity-0 group-hover:opacity-100" title="Forget"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="space-y-3">
              <div className="rounded-xl border border-brand-100 bg-brand-50/60 p-3 text-sm text-slate-700 dark:border-brand-900 dark:bg-brand-950/30 dark:text-slate-200">
                Ask about your own leads, contacts, properties, calls and follow-ups. I use live permission-scoped CRM data. If you ask me to change a record, I show you the exact change before doing it.
              </div>
              <div className="space-y-1.5">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} onClick={() => void send(suggestion)} className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-muted transition-colors hover:border-brand-300 hover:bg-brand-50 dark:border-slate-700 dark:hover:border-brand-800 dark:hover:bg-brand-950/40">
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, index) => {
            const module = message.query?.module as string | undefined;
            return (
              <div key={`${message.at ?? index}-${index}`} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[92%] rounded-xl px-3.5 py-2.5', message.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-800')}>
                  {message.role === 'user' ? <p className="whitespace-pre-wrap text-sm">{message.content}</p> : (
                    <>
                      <div className="prose-ai" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
                      {message.action && (
                        <ActionCard action={message.action} busy={actionBusy === message.action.id} onConfirm={(item) => void confirmAction(item)} onCancel={(item) => void cancelAction(item)} />
                      )}
                      {message.choices?.length ? (
                        <div className="mt-3 space-y-1 border-t border-slate-200 pt-2 dark:border-slate-700">
                          {message.choices.map((choice) => (
                            <PeekLink key={choice.id} module={choice.module} id={choice.id} label={choice.label} className="block rounded px-2 py-1.5 text-xs hover:bg-white [-webkit-touch-callout:none] dark:hover:bg-slate-700">
                              <span className="font-medium">{choice.label}</span>
                              <span className="ml-1 text-muted">{choice.recordNumber ? `· ${choice.recordNumber}` : `· ${choice.moduleLabel}`}</span>
                            </PeekLink>
                          ))}
                        </div>
                      ) : null}
                      {message.results && message.results.rows.length > 0 && module && (
                        <div className="mt-3 space-y-1 border-t border-slate-200 pt-2 dark:border-slate-700">
                          <div className="flex items-center justify-between">
                            <p className="text-2xs font-medium uppercase tracking-wide text-muted">{message.results.total} result{message.results.total === 1 ? '' : 's'}</p>
                            <Link to={`/${module}`} className="text-2xs text-brand-600 hover:underline dark:text-brand-400">Open module</Link>
                          </div>
                          {message.results.rows.slice(0, 8).map((row) => (
                            <PeekLink key={row.id} module={module} id={row.id} label={row.label} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-white [-webkit-touch-callout:none] dark:hover:bg-slate-700">
                              <span className="truncate font-medium text-slate-700 dark:text-slate-200">{row.label}</span>
                              {typeof row.values.ai_score === 'number' && <Badge color={Number(row.values.ai_score) >= 70 ? '#22c55e' : '#94a3b8'}>{String(row.values.ai_score)}</Badge>}
                            </PeekLink>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {busy && <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> Thinking from your CRM…</div>}
          <div ref={bottomRef} />
        </div>

        <form className="shrink-0 border-t border-slate-200 p-3 dark:border-slate-800" onSubmit={(event) => { event.preventDefault(); void send(input); }}>
          {(recording || transcribing) && (
            <p className="mb-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
              {recording ? <><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> Listening — tap stop when finished</> : <><Spinner className="h-3 w-3" /> Turning your voice into text…</>}
            </p>
          )}
          <div className="flex items-end gap-2 rounded-xl border border-slate-300 bg-white p-1.5 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100 dark:border-slate-700 dark:bg-slate-950 dark:focus-within:ring-brand-950">
            <textarea ref={inputRef} className="min-h-[38px] max-h-28 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none" rows={1} placeholder="Ask or tell iPropy what to do…" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(input); }
            }} disabled={busy || transcribing} />
            <button type="button" onClick={() => void startRecording()} className={cn('btn-ghost mb-0.5 p-2', recording && 'bg-red-100 text-red-600 dark:bg-red-950')} disabled={busy || transcribing} title={recording ? 'Stop recording' : 'Speak your question'}>
              {recording ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-4 w-4" />}
            </button>
            <button type="submit" className="btn-primary mb-0.5 p-2" disabled={busy || transcribing || !input.trim()} title="Send"><Send className="h-4 w-4" /></button>
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-muted">CRM-only answers · changes require confirmation · say “Remember that…” to save a preference</p>
        </form>
      </aside>
    </>
  );
}
