import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RecordEnvelope } from '@ipropy/shared';
import { Check, ExternalLink, ListPlus, Send, Sparkles } from 'lucide-react';
import { api, request } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { Modal, Select, Spinner } from './ui';

export default function ComposeModal({
  channel, module, record, onClose, onSent,
}: {
  channel: 'whatsapp' | 'email';
  module: string;
  record: RecordEnvelope;
  onClose: () => void;
  onSent: () => void;
}): JSX.Element {
  const { aiAvailable } = useApp();
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [handedOffBody, setHandedOffBody] = useState<string | null>(null);

  const to = channel === 'whatsapp'
    ? String(record.values.whatsapp_number ?? record.values.mobile ?? '')
    : String(record.values.email ?? '');

  const { data: whatsappChannel, isLoading: channelLoading } = useQuery({
    queryKey: ['outreach', 'channel'],
    queryFn: () => api.outreachChannel(),
    enabled: channel === 'whatsapp',
    staleTime: 60_000,
  });
  const deviceMode = channel === 'whatsapp' && whatsappChannel?.apiReady === false;

  const { data: templates } = useQuery({
    queryKey: [channel === 'whatsapp' ? 'wa-templates' : 'email-templates'],
    queryFn: () => (channel === 'whatsapp' ? api.whatsappTemplates() : api.emailTemplates()),
    enabled: channel === 'email' || whatsappChannel?.apiReady === true,
  });

  // Preview the template body when one is picked.
  useEffect(() => {
    if (!templateName) return;
    const t = (templates ?? []).find((x) => (x as { name: string }).name === templateName) as
      { body_text?: string; body_html?: string; subject?: string } | undefined;
    if (t?.body_text) setBody(t.body_text);
    if (t?.subject) setSubject(t.subject);
  }, [templateName, templates]);

  const draft = async (): Promise<void> => {
    setDrafting(true);
    try {
      const result = await api.draft({
        channel, recordId: record.id, module,
        goal: 'Move this conversation to the next step.',
        includeProperties: module === 'leads',
      });
      setBody(result.body);
      if (result.subject) setSubject(result.subject);
    } catch (err) {
      toast.error('Could not draft a message', (err as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const send = async (): Promise<void> => {
    setSending(true);
    try {
      if (channel === 'whatsapp') {
        if (deviceMode) {
          // Open synchronously so Safari/Chrome treat this as a user gesture;
          // awaiting the personalised link first would trigger popup blocking.
          const popup = window.open('about:blank', '_blank');
          if (popup) popup.opener = null;
          try {
            const prepared = await api.deviceLink({
              handle: to, body, recordId: record.id, module, render: true,
            });
            if (popup) popup.location.href = prepared.link;
            else window.location.href = prepared.link;
            setHandedOffBody(prepared.body);
            toast.info('WhatsApp opened', 'Press send there, then confirm here so the CRM timeline stays accurate.');
          } catch (err) {
            popup?.close();
            throw err;
          }
          return;
        }
        await api.startConversation({
          to,
          ...(templateName ? { templateName } : { text: body }),
        });
      } else {
        await request<unknown>('/api/comms/email', {
          method: 'POST',
          body: { to, subject, html: body.replace(/\n/g, '<br/>'), recordId: record.id },
        });
      }
      toast.success(channel === 'whatsapp' ? 'WhatsApp sent' : 'Email sent', to);
      onSent();
    } catch (err) {
      toast.error('Send failed', (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const confirmDeviceSend = async (): Promise<void> => {
    if (!handedOffBody) return;
    setSending(true);
    try {
      await api.logDeviceSent({ handle: to, body: handedOffBody, recordId: record.id, module });
      toast.success('WhatsApp logged as sent', to);
      onSent();
    } catch (err) {
      toast.error('Could not log the message', (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const addToQueue = async (): Promise<void> => {
    setSending(true);
    try {
      const result = await api.queueDeviceSend({
        handle: to, body, recordId: record.id, module, name: record.label,
        reason: 'Queued from record',
      });
      if (result.skipped) toast.error('Message not queued', result.skipped);
      else {
        toast.success('Added to your WhatsApp send queue');
        onSent();
      }
    } catch (err) {
      toast.error('Could not queue the message', (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${channel === 'whatsapp' ? 'WhatsApp' : 'Email'} — ${record.label}`}
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={sending}>Cancel</button>
          {deviceMode && !handedOffBody && (
            <button
              className="btn-secondary"
              onClick={() => void addToQueue()}
              disabled={sending || !body.trim() || !to}
            >
              <ListPlus className="h-4 w-4" /> Add to queue
            </button>
          )}
          {handedOffBody ? (
            <button className="btn-primary" onClick={() => void confirmDeviceSend()} disabled={sending}>
              {sending ? <Spinner /> : <Check className="h-4 w-4" />} I sent it
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={() => void send()}
              disabled={sending || channelLoading || (!body.trim() && !templateName) || !to}
            >
              {sending ? <Spinner /> : deviceMode ? <ExternalLink className="h-4 w-4" /> : <Send className="h-4 w-4" />}
              {deviceMode ? 'Open WhatsApp' : 'Send'}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">To</label>
          <input className="input tnum" value={to} disabled />
          {!to && (
            <p className="mt-1 text-xs text-amber-600">
              This record has no {channel === 'whatsapp' ? 'phone number' : 'email address'}.
            </p>
          )}
        </div>

        {!deviceMode && templates && templates.length > 0 && (
          <div>
            <label className="label">Template (optional)</label>
            <Select
              value={templateName}
              onChange={setTemplateName}
              placeholder="— Write a free-form message —"
              options={(templates ?? []).map((t) => ({
                value: String((t as { name: string }).name),
                label: String((t as { name: string }).name).replace(/_/g, ' '),
              }))}
            />
            {channel === 'whatsapp' && (
              <p className="mt-1 text-2xs text-muted">
                Outside the 24-hour customer service window, WhatsApp only accepts approved templates.
              </p>
            )}
          </div>
        )}

        {channel === 'email' && (
          <div>
            <label className="label">Subject</label>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
        )}

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="label mb-0">Message</label>
            {aiAvailable && (
              <button onClick={() => void draft()} disabled={drafting} className="btn-ghost btn-sm">
                {drafting ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3 w-3 text-brand-500" />}
                Draft with AI
              </button>
            )}
          </div>
          <textarea
            className="input"
            rows={channel === 'email' ? 10 : 5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Write your ${channel === 'whatsapp' ? 'WhatsApp message' : 'email'}…`}
            disabled={Boolean(templateName)}
          />
          {channel === 'whatsapp' && !templateName && (
            <p className="mt-1 text-2xs text-muted tnum">{body.length} characters</p>
          )}
        </div>

        {deviceMode && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            <p className="font-medium">One-tap WhatsApp mode</p>
            <p className="mt-0.5">
              The CRM personalises this message and opens it in your WhatsApp. You press send; delivery is not claimed automatically.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
