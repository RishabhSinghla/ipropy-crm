import { createContext, type JSX, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, MessageCircle, Paperclip, Send } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { formatDateTime } from '@ipropy/shared';
import { Modal, Spinner } from './ui';
import { composerMode, whyNoTextBox } from '../lib/whatsapp';
import { readMessageMedia, WhatsAppMedia } from './WhatsAppMedia';

/**
 * Writing a WhatsApp message without leaving the record.
 *
 * The icon beside a number used to take the rep to the Chats screen — the
 * right place to *work* an inbox, the wrong place to answer one question about
 * the person already on screen. This is the small version: the last few lines
 * of the thread, a box, and Send, over whatever they were doing.
 *
 * Three things it refuses to guess, because WhatsApp itself does not allow
 * them to be guessed:
 *
 *  * **The 24-hour window.** WhatsApp only carries a free reply for a day
 *    after the customer last wrote. Outside that, the composer offers approved
 *    templates instead of a box that would fail on send — with the finished
 *    wording shown first, since a positional template says nothing in the
 *    abstract.
 *  * **What the live provider can actually do.** AiSensy's API sends templates
 *    and nothing else, so the box is not offered there at all.
 *  * **Whether there is an official number at all.** With no provider switched
 *    on there is nothing to send from, and the icon goes back to opening the
 *    Chats screen as it does today.
 *
 * Opening it writes nothing. The conversation row is created by the first
 * message that actually goes, so a glance at a number never puts an empty
 * thread in the team's queue.
 */

interface ComposerActions {
  /** `to` is whatever the screen shows; the digits are taken from it. */
  compose: (to: string) => void;
}

const WhatsAppComposerContext = createContext<ComposerActions | null>(null);

/** Null wherever there is no record in view — the icon then links to Chats. */
export function useWhatsAppComposer(): ComposerActions | null {
  return useContext(WhatsAppComposerContext);
}

export function WhatsAppComposerProvider({ recordId, module, recordLabel, children }: {
  recordId: string;
  module: string;
  recordLabel: string;
  children: ReactNode;
}): JSX.Element {
  const [to, setTo] = useState<string | null>(null);
  const { data: status } = useQuery({ queryKey: ['wa-biz', 'status'], queryFn: () => api.waBizStatus() });
  /*
    A message being written belongs to the record it was opened on. This
    provider stays mounted while the split view moves from one record to the
    next (so the list keeps its scroll), so a composer left open must close
    rather than carry one person's number onto the next.
  */
  useEffect(() => { setTo(null); }, [recordId]);

  /*
    No official number, no composer — and deliberately not a composer that
    opens to say so. There is nothing to send from, and the icon's existing
    behaviour (the Chats screen on that thread) is still the useful one. So
    nothing about today changes until a provider is actually switched on, and
    the moment one is, every icon in the CRM becomes a composer.

    The provider itself is always there, with no composer in it until then:
    swapping the tree around `children` once the status arrives would rebuild
    the whole page underneath it.
  */
  return (
    <WhatsAppComposerContext.Provider value={status?.connected ? { compose: setTo } : null}>
      {children}
      {status?.connected && to && (
        <ComposerDialog
          key={recordId}
          to={to}
          module={module}
          recordId={recordId}
          recordLabel={recordLabel}
          onClose={() => setTo(null)}
        />
      )}
    </WhatsAppComposerContext.Provider>
  );
}

function ComposerDialog({ to, module, recordId, recordLabel, onClose }: {
  to: string;
  module: string;
  recordId: string;
  recordLabel: string;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const { data: status } = useQuery({ queryKey: ['wa-biz', 'status'], queryFn: () => api.waBizStatus() });
  const { data: thread, isLoading } = useQuery({
    queryKey: ['wa-biz', 'thread', to, recordId],
    queryFn: () => api.waBizThread(to, module, recordId),
  });
  const { data: templates } = useQuery({
    queryKey: ['wa-biz', 'templates', 'saved'],
    queryFn: () => api.waBizSavedTemplates(),
  });

  const canText = composerMode(status?.capabilities ?? [], Boolean(thread?.windowOpen)) === 'text';
  const approved = useMemo(
    () => (templates ?? []).filter((template) => template.status.toUpperCase() === 'APPROVED'),
    [templates],
  );

  // Preview the chosen template as this customer would read it. Asked of the
  // server, not assembled here: the values are the record's own and a browser
  // filling them could show — and send — a field its user may not read.
  const { data: preview } = useQuery({
    queryKey: ['wa-biz', 'preview', templateId, recordId],
    queryFn: () => api.waBizTemplatePreview(templateId, module, recordId),
    enabled: Boolean(templateId),
  });

  useEffect(() => {
    if (!canText && !templateId && approved.length) setTemplateId(approved[0].id);
  }, [canText, templateId, approved]);

  /*
    A file goes into the CRM first and is sent from there — the same road the
    Chats screen takes. The CRM's copy is what the conversation, the contact's
    Files tab and any future provider read; a file that only ever lived at a
    vendor is a broken square a year from now.
  */
  const sendFile = async (file: File): Promise<void> => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const uploaded = await api.uploadFile(file, recordId, module);
      await api.waBizSend({ to, attachmentId: uploaded.id, text: text.trim() || undefined, recordId });
      toast.success('Sent on WhatsApp', `${recordLabel} will see it on ${to}.`);
      setText('');
      void queryClient.invalidateQueries({ queryKey: ['wa-biz'] });
      onClose();
    } catch (err) {
      toast.error('Could not send that file', (err as Error).message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const send = async (): Promise<void> => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      if (canText) {
        if (!text.trim()) return;
        await api.waBizSend({ to, text: text.trim(), recordId });
      } else {
        if (!templateId) return;
        await api.waBizSendTemplate({ templateId, module, recordId, to });
      }
      toast.success('Sent on WhatsApp', `${recordLabel} will see it on ${to}.`);
      setText('');
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wa-biz'] }),
        queryClient.invalidateQueries({ queryKey: ['timeline', module, recordId] }),
      ]);
      onClose();
    } catch (err) {
      toast.error('Could not send that', (err as Error).message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`WhatsApp ${recordLabel} · ${to}`}
      size="sm"
      footer={(
        <>
          <button className="btn-secondary" onClick={onClose} disabled={sending}>Close</button>
          {canText && (
            <label
              className={cn('btn-secondary cursor-pointer', sending && 'pointer-events-none opacity-40')}
              title="Send a photo or document"
            >
              <Paperclip className="h-3.5 w-3.5" />
              <input
                type="file"
                className="hidden"
                aria-label="Send a photo or document"
                disabled={sending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Cleared before anything async, so the same file picked
                  // twice still fires a change and a retry is possible.
                  event.target.value = '';
                  if (file) void sendFile(file);
                }}
              />
            </label>
          )}
          <button
            className="btn-primary"
            disabled={sending || (canText ? !text.trim() : !templateId || Boolean(preview?.missing.length))}
            onClick={() => void send()}
          >
            {sending ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} Send
          </button>
        </>
      )}
    >
      <div className="space-y-3">
          {isLoading ? <Spinner className="h-4 w-4" /> : (
            <>
              {Boolean(thread?.messages.length) && (
                <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60">
                  {(thread?.messages ?? []).map((message) => (
                    <div
                      key={String(message.id)}
                      className={cn(
                        'max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs',
                        message.direction === 'outbound'
                          ? 'ml-auto bg-emerald-100 dark:bg-emerald-950/60'
                          : 'bg-white dark:bg-slate-900',
                      )}
                    >
                      {(() => {
                        const media = readMessageMedia(message.media);
                        return media ? (
                          <div className="mb-1"><WhatsAppMedia media={media} dark={message.direction === 'outbound'} /></div>
                        ) : null;
                      })()}
                      {Boolean(message.body) && <p className="whitespace-pre-wrap">{String(message.body)}</p>}
                      <p className="mt-0.5 text-2xs text-muted">{formatDateTime(String(message.created_at))}</p>
                    </div>
                  ))}
                </div>
              )}

              {canText ? (
                <textarea
                  className="input min-h-[96px]"
                  autoFocus
                  aria-label="Message"
                  placeholder={`Write to ${recordLabel}…`}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              ) : (
                <div className="space-y-2">
                  <p className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted dark:bg-slate-800/60">
                    <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {whyNoTextBox(status?.capabilities ?? [], status?.provider ?? null)}
                  </p>
                  <label className="block">
                    <span className="label">Template</span>
                    <select
                      className="input"
                      aria-label="Template"
                      value={templateId}
                      onChange={(event) => setTemplateId(event.target.value)}
                    >
                      {!approved.length && <option value="">No approved template yet</option>}
                      {approved.map((template) => (
                        <option key={template.id} value={template.id}>{template.name}</option>
                      ))}
                    </select>
                  </label>
                  {preview && (
                    <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
                      <p className="whitespace-pre-wrap">{preview.preview}</p>
                      {Boolean(preview.missing.length) && (
                        <ul className="mt-2 list-disc pl-4 text-xs text-negative">
                          {preview.missing.map((gap) => (
                            <li key={gap.slot}>{`{{${gap.slot}}} — ${gap.reason}`}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}

              {thread?.assignedName && (
                <p className="flex items-center gap-1.5 text-2xs text-muted">
                  <MessageCircle className="h-3 w-3" />
                  {thread.assignedName} is looking after this conversation.
                </p>
              )}
            </>
          )}
      </div>
    </Modal>
  );
}
