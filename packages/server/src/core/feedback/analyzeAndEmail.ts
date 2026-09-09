/**
 * New report flow — unplugged from GitHub.
 *
 * User reports a problem in Hinglish/Hindi + optional screenshots.
 * AI analyzes everything (vision for screenshots + text), builds a super prompt,
 * and emails the original + AI prompt to the owner. Owner reviews, then decides
 * what to do — give it to an AI engineer, fix it themselves, whatever.
 *
 * No GitHub issues, no autonomous agents, no poller. Just: report → AI understands → email.
 * (The email is the whole delivery: if it fails, the report exists only in the
 * CRM's own list — which is why tests/feedbackEmail.test.ts pins this flow.)
 */

import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { complete } from '../../ai/client.js';
import { sendEmail } from '../../integrations/email/service.js';

const OWNER_EMAIL = process.env.REPORT_EMAIL_TO || 'rishabhsinghla2112@gmail.com';

export async function analyzeAndEmail(feedbackId: string): Promise<void> {
  try {
    const fb = await db.queryOne<{
      id: string; text: string; kind: string; severity: string;
      module_name: string | null; route: string | null;
      reporter_first: string | null; reporter_last: string | null;
    }>(
      `SELECT f.*, u.first_name AS reporter_first, u.last_name AS reporter_last
         FROM ipy_feedback f JOIN ipy_user u ON u.id = f.user_id
        WHERE f.id = $1`,
      [feedbackId],
    );
    if (!fb) return;

    const reporter = `${fb.reporter_first ?? ''} ${fb.reporter_last ?? ''}`.trim() || 'A team member';

    const atts = await db.query<{ id: string; storage_key: string; mime_type: string }>(
      `SELECT id, storage_key, mime_type FROM ipy_attachment
        WHERE record_id = $1 AND mime_type LIKE 'image/%' ORDER BY created_at`,
      [feedbackId],
    );

    const images: { data: Buffer; mimeType: string }[] = [];
    if (atts.rows.length) {
      const { getDriver } = await import('../storage/index.js');
      const driver = await getDriver();
      for (const att of atts.rows.slice(0, 3)) {
        const bytes = await driver.read(att.storage_key).catch(() => null);
        if (bytes?.length) images.push({ data: bytes, mimeType: att.mime_type });
      }
    }

    const aiResponse = await analyzeWithAi(fb, reporter, images);

    await db.query(
      `UPDATE ipy_feedback SET ai_summary = $2, updated_at = now() WHERE id = $1`,
      [feedbackId, aiResponse],
    );

    await sendReportEmail(fb, reporter, images, aiResponse);

    logger.info({ feedbackId, to: OWNER_EMAIL }, 'report emailed to owner');
  } catch (err) {
    logger.error({ err, feedbackId }, 'analyzeAndEmail failed');
  }
}

async function analyzeWithAi(
  fb: { text: string; kind: string; severity: string; module_name: string | null; route: string | null },
  reporter: string,
  images: { data: Buffer; mimeType: string }[],
): Promise<string> {
  const system = `You are an expert technical analyst for a real-estate CRM (iPropy).
A team member reported a problem in Hinglish, Hindi, or English — sometimes with screenshots.
Your job: analyze everything (images + text) and produce a crisp, actionable report
in English that a developer can immediately act on.

OUTPUT FORMAT (markdown):
## Summary
One clear sentence: what the problem is.

## Root Cause
What's actually wrong (be specific — file names, field names, UI element if known).

## Reproduction Steps
Numbered steps to reproduce, from the report + screenshot evidence.

## Suggested Fix
Concrete fix — which file(s), what to change. Be specific.

## Evidence from Screenshots
What you saw in the images that supports your analysis.

Keep it tight. No fluff. If the report is vague, say what's missing.`;

  const userText = `Reporter: ${reporter}
Type: ${fb.kind} | Severity: ${fb.severity}
Module: ${fb.module_name ?? 'unknown'} | Screen: ${fb.route ?? 'unknown'}

Report message:
${fb.text}`;

  const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [
    { type: 'text', text: userText },
  ];

  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data.toString('base64') },
    });
  }

  const response = await complete({
    feature: 'feedback_analysis',
    prompt: userText,
    system,
    maxTokens: 2000,
    images: images.length > 0 ? images.map((img) => ({
      data: img.data,
      mimeType: img.mimeType,
    })) : undefined,
  });

  if (!response?.text) return 'AI analysis unavailable.';

  return response.text;
}

async function sendReportEmail(
  fb: { id: string; text: string; kind: string; severity: string; module_name: string | null; route: string | null },
  reporter: string,
  images: { data: Buffer; mimeType: string }[],
  aiResponse: string,
): Promise<void> {
  const subject = `[iPropy Report] ${fb.kind}: ${fb.severity} — ${fb.module_name ?? fb.route ?? 'unknown'}`;

  const html = `
<div style="font-family: system-ui, sans-serif; max-width: 700px; margin: 0 auto;">
  <h2 style="color: #1e293b; border-bottom: 2px solid #3b82f6; padding-bottom: 8px;">
    📋 New Problem Report
  </h2>

  <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0;">
    <p><strong>From:</strong> ${reporter}</p>
    <p><strong>Type:</strong> ${fb.kind} | <strong>Severity:</strong> ${fb.severity}</p>
    <p><strong>Module:</strong> ${fb.module_name ?? 'unknown'} | <strong>Screen:</strong> ${fb.route ?? 'unknown'}</p>
  </div>

  <h3 style="color: #1e293b;">💬 Original Message</h3>
  <blockquote style="border-left: 4px solid #3b82f6; padding-left: 16px; color: #475569;">
    ${fb.text.replace(/\n/g, '<br>')}
  </blockquote>

  <h3 style="color: #1e293b;">🤖 AI Analysis</h3>
  <div style="background: #f0fdf4; border-radius: 8px; padding: 16px; border: 1px solid #bbf7d0;">
    ${aiResponse.replace(/\n/g, '<br>')}
  </div>

  <p style="margin-top: 24px; font-size: 12px; color: #94a3b8;">
    Report ID: ${fb.id} | iPropy CRM
  </p>
</div>`;

  const attachments = images.map((img, i) => ({
    filename: `screenshot-${i + 1}.${img.mimeType.split('/')[1]}`,
    content: img.data,
    contentType: img.mimeType,
  }));

  await sendEmail({
    to: OWNER_EMAIL,
    subject,
    html,
    attachments,
  });
}
