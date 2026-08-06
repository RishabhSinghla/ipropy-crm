/**
 * Outbound email over SMTP, with open tracking and CRM logging.
 * Without SMTP credentials the message is logged and marked sent, so the rest
 * of the product stays exercisable.
 */
import crypto from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { renderTemplate } from '@ipropy/shared';
import { config } from '../../config.js';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { NotFoundError } from '../../utils/errors.js';

let transporter: Transporter | null = null;
let transporterChecked = false;

function getTransporter(): Transporter | null {
  if (transporterChecked) return transporter;
  transporterChecked = true;
  if (!config.email.host) {
    logger.info('SMTP not configured — emails will be logged only');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: config.email.user ? { user: config.email.user, pass: config.email.password } : undefined,
    pool: true,
    maxConnections: 5,
  });
  return transporter;
}

export interface SendEmailInput {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  attachments?: { filename: string; path?: string; content?: Buffer; contentType?: string }[];
  recordId?: string | null;
  sentBy?: string | null;
  templateId?: string | null;
  isAiGenerated?: boolean;
  /** append a 1x1 pixel so opens are tracked */
  track?: boolean;
}

export async function sendEmail(input: SendEmailInput): Promise<{ id: string; status: string; error?: string }> {
  const to = Array.isArray(input.to) ? input.to : [input.to];
  const trackingId = crypto.randomUUID();

  let html = input.html;
  if (input.track !== false) {
    const pixel = `<img src="${config.apiUrl}/api/webhooks/email/open/${trackingId}.gif" width="1" height="1" alt="" style="display:none" />`;
    html = html.includes('</body>') ? html.replace('</body>', `${pixel}</body>`) : `${html}${pixel}`;
  }

  const log = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_email_log
      (record_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses,
       subject, body_html, body_text, status, template_id, tracking_id, sent_by, is_ai_generated)
     VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12)
     RETURNING id`,
    [
      input.recordId ?? null, config.email.from,
      JSON.stringify(to), JSON.stringify(input.cc ?? []), JSON.stringify(input.bcc ?? []),
      input.subject, html, input.text ?? null,
      input.templateId ?? null, trackingId, input.sentBy ?? null, input.isAiGenerated ?? false,
    ],
  );

  const tx = getTransporter();
  if (!tx) {
    logger.info({ to, subject: input.subject }, '[email:simulated] no SMTP configured');
    await db.query(`UPDATE ipy_email_log SET status = 'sent' WHERE id = $1`, [log!.id]);
    return { id: log!.id, status: 'sent' };
  }

  try {
    const info = await tx.sendMail({
      from: config.email.from,
      to, cc: input.cc, bcc: input.bcc,
      subject: input.subject,
      html,
      text: input.text ?? stripHtml(html),
      replyTo: input.replyTo,
      attachments: input.attachments,
    });
    await db.query(`UPDATE ipy_email_log SET status = 'sent', provider_id = $2 WHERE id = $1`, [log!.id, info.messageId]);
    return { id: log!.id, status: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, to }, 'email send failed');
    await db.query(`UPDATE ipy_email_log SET status = 'failed', error_message = $2 WHERE id = $1`, [log!.id, message]);
    return { id: log!.id, status: 'failed', error: message };
  }
}

export interface TemplatedEmailInput {
  to: string | string[];
  templateName?: string;
  subject?: string;
  html?: string;
  recordId?: string | null;
  scope: Record<string, unknown>;
  sentBy?: string | null;
}

export async function sendTemplatedEmail(input: TemplatedEmailInput): Promise<{ id: string; status: string }> {
  let subject = input.subject;
  let html = input.html;
  let templateId: string | null = null;

  if (input.templateName) {
    const template = await db.queryOne<{ id: string; subject: string; body_html: string }>(
      `SELECT id, subject, body_html FROM ipy_email_template WHERE name = $1 AND is_active`,
      [input.templateName],
    );
    if (!template) throw new NotFoundError(`Unknown email template '${input.templateName}'`);
    templateId = template.id;
    subject = renderTemplate(template.subject, input.scope);
    html = renderTemplate(template.body_html, input.scope);
  }

  if (!subject || !html) throw new NotFoundError('Email needs a template or an explicit subject and body');

  return sendEmail({
    to: input.to, subject, html,
    recordId: input.recordId ?? null,
    templateId, sentBy: input.sentBy ?? null,
  });
}

export async function recordOpen(trackingId: string): Promise<void> {
  await db.query(
    `UPDATE ipy_email_log
     SET opened_at = COALESCE(opened_at, now()), open_count = open_count + 1
     WHERE tracking_id = $1`,
    [trackingId],
  );
}

export async function verifyConnection(): Promise<{ ok: boolean; error?: string }> {
  const tx = getTransporter();
  if (!tx) return { ok: false, error: 'SMTP is not configured' };
  try {
    await tx.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
