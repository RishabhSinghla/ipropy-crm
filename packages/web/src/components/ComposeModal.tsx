import { type JSX, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RecordEnvelope } from '@ipropy/shared';
import { Send, Sparkles } from 'lucide-react';
import { api, request } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { Modal, Select, Spinner } from './ui';

/**
 * Compose an email against a record.
 *
 * It used to compose WhatsApp too, either through Meta or by handing the
 * message to the rep's own phone. Both doors were removed on 17 September 2026
 * on the owner's instruction, so what is left is email.
 */
export default function ComposeModal({
  module, record, onClose, onSent,
}: {
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

  const to = String(record.values.email ?? '');

  const { data: templates } = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => api.emailTemplates(),
  });

  // Preview the template body when one is picked.
  useEffect(() => {
    if (!templateName) return;
    const t = (templates ?? []).find((x) => (x as { name: string }).name === templateName) as
      { body_html?: string; subject?: string } | undefined;
    if (t?.body_html) setBody(t.body_html);
    if (t?.subject) setSubject(t.subject);
  }, [templateName, templates]);

  const draft = async (): Promise<void> => {
    setDrafting(true);
    try {
      const result = await api.draft({
        channel: 'email', recordId: record.id, module,
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
      await request<unknown>('/api/comms/email', {
        method: 'POST',
        body: { to, subject, html: body.replace(/\n/g, '<br/>'), recordId: record.id },
      });
      toast.success('Email sent', to);
      onSent();
    } catch (err) {
      toast.error('Send failed', (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Email — ${record.label}`}
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={sending}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => void send()}
            disabled={sending || (!body.trim() && !templateName) || !to}
          >
            {sending ? <Spinner /> : <Send className="h-4 w-4" />}
            Send
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">To</label>
          <input className="input tnum" value={to} disabled />
          {!to && <p className="mt-1 text-xs text-amber-600">This record has no email address.</p>}
        </div>

        {templates && templates.length > 0 && (
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
          </div>
        )}

        <div>
          <label className="label">Subject</label>
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>

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
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your email…"
            disabled={Boolean(templateName)}
          />
        </div>
      </div>
    </Modal>
  );
}
