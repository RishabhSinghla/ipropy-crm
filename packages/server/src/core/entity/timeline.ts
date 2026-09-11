/**
 * Unified record timeline.
 *
 * Merges audit entries, comments, WhatsApp/SMS messages, calls, emails and
 * attachments into one chronological feed. This is what makes the contact view
 * "interactive" — every interaction with a person lands in the same place
 * regardless of channel.
 *
 * **AI insights are deliberately not here.** A score the model recalculates
 * whenever the record changes is not something that *happened* to the customer,
 * and interleaving it with real calls and messages buried the events a
 * salesperson opens this page to read. Insights live in the AI Insights panel
 * beside the feed (`ipy_ai_insight`, served by `/ai/insights`), which is where
 * the current one belongs — one panel, always the latest, rather than a growing
 * pile of superseded copies in the history.
 */
import { formatIndianPrice, type TimelineEntry } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';

export interface TimelineOptions {
  limit?: number;
  before?: string;
  types?: string[];
}

export async function buildTimeline(
  recordId: string,
  opts: TimelineOptions = {},
  conn: Tx = db,
): Promise<TimelineEntry[]> {
  const limit = Math.min(300, opts.limit ?? 60);
  const wanted = opts.types?.length ? new Set(opts.types) : null;
  const want = (t: string): boolean => !wanted || wanted.has(t);

  const [audit, comments, messages, calls, emails, attachments] =
    await Promise.all([
      want('audit')
        ? conn.query<AuditRow>(
            `SELECT a.id::text, a.action, a.changes, a.created_at, a.source, a.user_id,
                    trim(u.first_name || ' ' || u.last_name) AS user_name
             FROM ipy_audit a LEFT JOIN ipy_user u ON u.id = a.user_id
             WHERE a.record_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
            [recordId, limit],
          )
        : empty<AuditRow>(),

      want('comment')
        ? conn.query<CommentRow>(
            `SELECT c.id::text, c.body, c.created_at, c.user_id, c.is_private,
                    trim(u.first_name || ' ' || u.last_name) AS user_name
             FROM ipy_comment c JOIN ipy_user u ON u.id = c.user_id
             WHERE c.record_id = $1 ORDER BY c.created_at DESC LIMIT $2`,
            [recordId, limit],
          )
        : empty<CommentRow>(),

      want('message')
        ? conn.query<MessageRow>(
            `SELECT m.id::text, m.direction, m.channel, m.type, m.body, m.status,
                    m.is_ai_generated, m.created_at, m.sent_by, m.media,
                    trim(u.first_name || ' ' || u.last_name) AS user_name
             FROM ipy_message m
             JOIN ipy_conversation cv ON cv.id = m.conversation_id
             LEFT JOIN ipy_user u ON u.id = m.sent_by
             WHERE cv.record_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
            [recordId, limit],
          )
        : empty<MessageRow>(),

      want('call')
        ? conn.query<CallRow>(
            `SELECT c.id::text, c.direction, c.status, c.duration_seconds, c.disposition,
                    c.recording_url, c.ai_summary, c.ai_sentiment, c.started_at, c.user_id,
                    c.from_number, c.to_number, c.transcript,
                    trim(u.first_name || ' ' || u.last_name) AS user_name
             FROM ipy_call c LEFT JOIN ipy_user u ON u.id = c.user_id
             WHERE c.record_id = $1 ORDER BY c.started_at DESC LIMIT $2`,
            [recordId, limit],
          )
        : empty<CallRow>(),

      want('email')
        ? conn.query<EmailRow>(
            `SELECT e.id::text, e.subject, e.direction, e.status, e.to_addresses,
                    e.opened_at, e.open_count, e.created_at, e.sent_by,
                    trim(u.first_name || ' ' || u.last_name) AS user_name
             FROM ipy_email_log e LEFT JOIN ipy_user u ON u.id = e.sent_by
             WHERE e.record_id = $1 ORDER BY e.created_at DESC LIMIT $2`,
            [recordId, limit],
          )
        : empty<EmailRow>(),

      want('attachment')
        ? conn.query<AttachmentRow>(
            `SELECT a.id::text, a.file_name, a.mime_type, a.size, a.created_at, a.uploaded_by,
                    trim(u.first_name || ' ' || u.last_name) AS user_name
             FROM ipy_attachment a LEFT JOIN ipy_user u ON u.id = a.uploaded_by
             WHERE a.record_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
            [recordId, limit],
          )
        : empty<AttachmentRow>(),
    ]);

  const entries: TimelineEntry[] = [];

  /*
    Audit rows store values exactly as written, so a reference is a UUID. A
    UUID tells a salesperson nothing, so every id in the feed is resolved to
    the name behind it — user, group or record.

    Deliberately not keyed on field names: those get renamed here constantly,
    and a hand-listed set of "the id fields" is what breaks silently the next
    time one moves. Anything shaped like a UUID is looked up instead, and a
    value that matches nothing renders as it always did.
  */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = new Set<string>();
  const collect = (v: unknown): void => {
    if (typeof v === 'string' && UUID.test(v)) ids.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
  };
  for (const row of audit.rows) {
    for (const raw of Array.isArray(row.changes) ? row.changes : []) {
      const change = raw as { from?: unknown; to?: unknown };
      collect(change.from);
      collect(change.to);
    }
  }
  const list = [...ids];
  const [users, groups, records] = list.length
    ? await Promise.all([
        conn.query<{ id: string; name: string }>(
          `SELECT id, trim(first_name || ' ' || last_name) AS name FROM ipy_user WHERE id = ANY($1::uuid[])`, [list]),
        conn.query<{ id: string; name: string }>(
          `SELECT id, name FROM ipy_group WHERE id = ANY($1::uuid[])`, [list]),
        conn.query<{ id: string; name: string }>(
          `SELECT id, label AS name FROM ipy_record WHERE id = ANY($1::uuid[])`, [list]),
      ])
    : [{ rows: [] }, { rows: [] }, { rows: [] }] as { rows: { id: string; name: string }[] }[];
  const nameById = new Map<string, string>();
  for (const row of [...records.rows, ...groups.rows, ...users.rows]) {
    if (row.name?.trim()) nameById.set(row.id, row.name.trim());
  }
  /*
    An audit row keeps the label the field had when the edit happened, and
    fields get renamed here constantly — so a feed read today is captioned
    with words that are no longer on the screen anywhere ("Owner" for what
    the record now calls "Assigned To"). Read the current label instead,
    matched on either the field's name or its column, since audit rows are
    written with the column.
  */
  const changedFields = new Set<string>();
  for (const row of audit.rows) {
    for (const raw of Array.isArray(row.changes) ? row.changes : []) {
      const field = (raw as { field?: unknown }).field;
      if (typeof field === 'string') changedFields.add(field);
    }
  }
  const labels = changedFields.size
    ? await conn.query<{ key: string; label: string; uitype: string }>(
        `SELECT DISTINCT ON (key) key, f.label, f.uitype
           FROM ipy_record r
           JOIN ipy_module m ON m.name = r.module_name
           JOIN ipy_field f ON f.module_id = m.id
           CROSS JOIN LATERAL (VALUES (f.name), (f.column_name)) AS k(key)
          WHERE r.id = $1 AND k.key = ANY($2::text[])`,
        [recordId, [...changedFields]],
      )
    : { rows: [] as { key: string; label: string; uitype: string }[] };
  const labelByField = new Map(labels.rows.map((row) => [row.key, row.label]));
  const uitypeByField = new Map(labels.rows.map((row) => [row.key, row.uitype]));

  /*
    A budget in the feed read `17500000 → 21000000`. That is the number the
    column holds and nobody in this business thinks in it; the same value is
    ₹1.75 Cr everywhere else on the screen. Money and dates are rendered the
    way the rest of the CRM renders them.
  */
  const asTyped = (uitype: string | undefined, v: unknown): string | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    if (uitype === 'currency' && Number.isFinite(Number(v))) return formatIndianPrice(Number(v));
    if ((uitype === 'date' || uitype === 'datetime') && typeof v === 'string') {
      const when = new Date(v);
      if (!Number.isNaN(when.getTime())) {
        return when.toLocaleDateString('en-IN', {
          day: 'numeric', month: 'short', year: 'numeric',
          ...(uitype === 'datetime' ? { hour: '2-digit', minute: '2-digit' } : {}),
        });
      }
    }
    return undefined;
  };

  const named = (v: unknown): string | undefined => {
    if (typeof v === 'string') return nameById.get(v);
    if (Array.isArray(v)) {
      const parts = v.map((x) => (typeof x === 'string' ? nameById.get(x) : undefined));
      if (parts.some(Boolean)) return parts.map((part, i) => part ?? fmt(v[i])).join(', ');
    }
    return undefined;
  };

  for (const r of audit.rows) {
    const changes = (Array.isArray(r.changes) ? r.changes : []).map((raw) => {
      const change = raw as Record<string, unknown>;
      const key = typeof change.field === 'string' ? change.field : undefined;
      const uitype = key ? uitypeByField.get(key) : undefined;
      const fromDisplay = named(change.from) ?? asTyped(uitype, change.from);
      const toDisplay = named(change.to) ?? asTyped(uitype, change.to);
      const label = (key ? labelByField.get(key) : undefined) ?? change.label;
      if (fromDisplay === undefined && toDisplay === undefined && label === change.label) return change;
      return {
        ...change,
        label,
        ...(fromDisplay === undefined ? {} : { fromDisplay }),
        ...(toDisplay === undefined ? {} : { toDisplay }),
      };
    });
    // A create event lists every initial value — too noisy for a feed.
    /*
      Where a record came from belongs in its own history.

      "Record created" is the same sentence whether somebody typed it or it
      arrived in a file of four thousand, and a week later that is the
      difference between "the rep chose Referral" and "the whole file was
      referrals". The source is already on the audit row.
    */
    const how = r.source === 'import' ? ' by import'
      : r.source === 'api_key' ? ' by a connected app'
        : '';
    const title = r.action === 'create' ? `Record created${how}`
      : r.action === 'delete' ? 'Record deleted'
      : r.action === 'restore' ? 'Record restored'
      : changes.length === 1
        ? `Changed ${(changes[0] as { label?: string }).label ?? 'a field'}${how}`
        : `Updated ${changes.length} fields${how}`;
    entries.push({
      id: `audit-${r.id}`, type: 'audit', at: r.created_at,
      actorId: r.user_id, actorName: r.user_name ?? 'System',
      title,
      body: r.action === 'update' ? summariseChanges(changes) : null,
      icon: r.action === 'create' ? 'plus-circle' : r.action === 'delete' ? 'trash-2' : 'pencil',
      meta: { action: r.action, changes, source: r.source },
    });
  }

  for (const r of comments.rows) {
    entries.push({
      id: `comment-${r.id}`, type: 'comment', at: r.created_at,
      actorId: r.user_id, actorName: r.user_name,
      title: r.is_private ? 'Private note' : 'Comment',
      body: r.body, icon: 'message-square',
      meta: { isPrivate: r.is_private },
    });
  }

  for (const r of messages.rows) {
    const inbound = r.direction === 'inbound';
    entries.push({
      id: `msg-${r.id}`, type: 'message', at: r.created_at,
      actorId: r.sent_by, actorName: inbound ? 'Customer' : (r.user_name ?? (r.is_ai_generated ? 'AI Assistant' : 'System')),
      title: `${inbound ? 'Received' : 'Sent'} ${r.channel === 'whatsapp' ? 'WhatsApp' : r.channel}`,
      body: r.body ?? (r.media ? `[${r.type}]` : null),
      icon: r.channel === 'whatsapp' ? 'message-circle' : 'mail',
      meta: { direction: r.direction, channel: r.channel, status: r.status, isAi: r.is_ai_generated, media: r.media },
    });
  }

  for (const r of calls.rows) {
    const mins = Math.floor(r.duration_seconds / 60);
    const secs = r.duration_seconds % 60;
    entries.push({
      id: `call-${r.id}`, type: 'call', at: r.started_at,
      actorId: r.user_id, actorName: r.user_name ?? 'System',
      title: `${r.direction === 'inbound' ? 'Inbound' : r.direction === 'missed' ? 'Missed' : 'Outbound'} call${
        r.status === 'completed' ? ` · ${mins}m ${secs}s` : ` · ${r.status.replace(/_/g, ' ')}`}`,
      body: r.ai_summary ?? r.disposition,
      icon: r.direction === 'missed' || r.status !== 'completed' ? 'phone-missed' : 'phone',
      meta: {
        direction: r.direction, status: r.status, duration: r.duration_seconds,
        disposition: r.disposition, recordingUrl: r.recording_url, sentiment: r.ai_sentiment,
        from: r.from_number, to: r.to_number,
        // The id and the transcript travel with the entry so the timeline can
        // offer Transcribe and Summarise where the call happened, rather than
        // sending somebody to the Calls page to find the same recording again.
        callId: r.id, transcript: r.transcript, summary: r.ai_summary,
      },
    });
  }

  for (const r of emails.rows) {
    entries.push({
      id: `email-${r.id}`, type: 'email', at: r.created_at,
      actorId: r.sent_by, actorName: r.user_name ?? 'System',
      title: `${r.direction === 'inbound' ? 'Received' : 'Sent'} email${r.opened_at ? ' · opened' : ''}`,
      body: r.subject, icon: 'mail',
      meta: { status: r.status, openCount: r.open_count, to: r.to_addresses },
    });
  }

  for (const r of attachments.rows) {
    entries.push({
      id: `file-${r.id}`, type: 'attachment', at: r.created_at,
      actorId: r.uploaded_by, actorName: r.user_name ?? 'System',
      title: 'File uploaded', body: r.file_name, icon: 'paperclip',
      meta: { mimeType: r.mime_type, size: r.size, attachmentId: r.id },
    });
  }

  return entries
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);
}

function summariseChanges(changes: unknown[]): string {
  return changes
    .slice(0, 4)
    .map((c) => {
      const change = c as { label?: string; field?: string; fromDisplay?: string; toDisplay?: string; from?: unknown; to?: unknown };
      const from = change.fromDisplay ?? fmt(change.from);
      const to = change.toDisplay ?? fmt(change.to);
      return `${change.label ?? change.field}: ${from} → ${to}`;
    })
    .join('\n') + (changes.length > 4 ? `\n…and ${changes.length - 4} more` : '');
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function empty<T>(): Promise<{ rows: T[]; rowCount: number }> {
  return Promise.resolve({ rows: [], rowCount: 0 });
}

// --- row shapes ------------------------------------------------------------
interface AuditRow { id: string; action: string; changes: unknown[]; created_at: string; source: string; user_id: string | null; user_name: string | null }
interface CommentRow { id: string; body: string; created_at: string; user_id: string; user_name: string; is_private: boolean }
interface MessageRow { id: string; direction: string; channel: string; type: string; body: string | null; status: string; is_ai_generated: boolean; created_at: string; sent_by: string | null; user_name: string | null; media: unknown }
interface CallRow { id: string; direction: string; status: string; duration_seconds: number; disposition: string | null; recording_url: string | null; ai_summary: string | null; ai_sentiment: string | null; started_at: string; user_id: string | null; user_name: string | null; from_number: string; to_number: string; transcript: string | null }
interface EmailRow { id: string; subject: string | null; direction: string; status: string; to_addresses: unknown; opened_at: string | null; open_count: number; created_at: string; sent_by: string | null; user_name: string | null }
interface AttachmentRow { id: string; file_name: string; mime_type: string; size: number; created_at: string; uploaded_by: string | null; user_name: string | null }
