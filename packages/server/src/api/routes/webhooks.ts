/**
 * Public webhook endpoints.
 *
 * Deliberately mounted before the auth middleware — every handler authenticates
 * on its own terms (signature verification, verify tokens, or a public form key)
 * and returns 200 quickly so providers don't retry.
 */
import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { getSettings } from '../../core/settings/integrations.js';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../utils/errors.js';
import * as waProvider from '../../integrations/whatsapp/provider.js';
import * as waService from '../../integrations/whatsapp/service.js';
import { routeInboundCall, updateCallStatus } from '../../integrations/telephony/service.js';
import {
  captureLead, normalizeFacebook, normalizeGoogleAds, normalizePortal, type NormalizedLead,
} from '../../integrations/leadsources/capture.js';
import { recordOpen } from '../../integrations/email/service.js';

export const webhooksRouter = Router();

// ---------------------------------------------------------------------------
// WhatsApp (Meta Cloud API)
// ---------------------------------------------------------------------------

/** Meta's subscription handshake. */
webhooksRouter.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === getSettings().whatsapp.verifyToken) {
    logger.info('whatsapp webhook verified');
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

interface MetaWebhookBody {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: {
          from: string; id: string; timestamp: string; type: string;
          text?: { body: string };
          image?: { id: string; mime_type: string; caption?: string };
          document?: { id: string; mime_type: string; filename?: string; caption?: string };
          audio?: { id: string; mime_type: string };
          video?: { id: string; mime_type: string; caption?: string };
          location?: { latitude: number; longitude: number; name?: string };
          button?: { payload?: string; text?: string };
          interactive?: {
            type: string;
            button_reply?: { id: string; title: string };
            list_reply?: { id: string; title: string };
          };
        }[];
        statuses?: { id: string; status: string; timestamp: string; errors?: { title?: string }[] }[];
      };
    }[];
  }[];
}

webhooksRouter.post('/whatsapp', asyncHandler(async (req, res) => {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
  if (!waProvider.verifyWebhookSignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
    logger.warn('rejected whatsapp webhook with an invalid signature');
    res.sendStatus(401);
    return;
  }

  // Acknowledge immediately; Meta retries aggressively on slow responses.
  res.sendStatus(200);

  const body = req.body as MetaWebhookBody;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      const profileName = value.contacts?.[0]?.profile?.name;

      for (const msg of value.messages ?? []) {
        try {
          await waService.handleInbound({
            from: msg.from,
            providerMessageId: msg.id,
            type: msg.type,
            timestamp: Number(msg.timestamp),
            profileName,
            text: msg.text?.body,
            mediaId: msg.image?.id ?? msg.document?.id ?? msg.audio?.id ?? msg.video?.id,
            mimeType: msg.image?.mime_type ?? msg.document?.mime_type ?? msg.audio?.mime_type ?? msg.video?.mime_type,
            caption: msg.image?.caption ?? msg.document?.caption ?? msg.video?.caption,
            filename: msg.document?.filename,
            buttonPayload: msg.button?.text
              ?? msg.interactive?.button_reply?.title
              ?? msg.interactive?.list_reply?.title,
            location: msg.location,
          });
          await waProvider.markRead(msg.id).catch(() => undefined);
        } catch (err) {
          logger.error({ err, messageId: msg.id }, 'failed to process inbound whatsapp message');
        }
      }

      for (const status of value.statuses ?? []) {
        await waService.handleStatusUpdate(status.id, status.status, Number(status.timestamp))
          .catch((err) => logger.warn({ err }, 'whatsapp status update failed'));
      }
    }
  }
}));

// ---------------------------------------------------------------------------
// Telephony
// ---------------------------------------------------------------------------

webhooksRouter.post('/telephony/:provider/status', asyncHandler(async (req, res) => {
  res.sendStatus(200);

  const body = req.body as Record<string, string>;
  const provider = req.params.provider;

  // Providers disagree on casing and field names; normalise here.
  const providerCallId = body.CallSid ?? body.CallUuid ?? body.Sid ?? body.call_sid ?? body.CallId;
  const status = body.CallStatus ?? body.Status ?? body.status ?? '';
  if (!providerCallId) return;

  const duration = Number(body.CallDuration ?? body.Duration ?? body.DialCallDuration ?? 0);
  const recordingUrl = body.RecordingUrl ?? body.RecordingUrl0 ?? body.recording_url;

  await updateCallStatus({
    providerCallId,
    status,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    recordingUrl: recordingUrl || undefined,
    endedAt: ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status) ? new Date() : undefined,
  }).catch((err) => logger.error({ err, provider }, 'call status update failed'));
}));

webhooksRouter.post('/telephony/:provider/recording', asyncHandler(async (req, res) => {
  res.sendStatus(200);
  const body = req.body as Record<string, string>;
  const providerCallId = body.CallSid ?? body.CallUuid ?? body.Sid;
  const recordingUrl = body.RecordingUrl ?? body.recording_url;
  if (!providerCallId || !recordingUrl) return;

  await db.query(`UPDATE ipy_call SET recording_url = $2 WHERE provider_call_id = $1`, [providerCallId, recordingUrl]);

  const call = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_call WHERE provider_call_id = $1`, [providerCallId]);
  if (call) {
    const { analyseCallRecording } = await import('../../ai/callAnalysis.js');
    void analyseCallRecording(call.id).catch((err) => logger.warn({ err }, 'call analysis failed'));
  }
}));

/**
 * Inbound call routing. Returns TwiML for Twilio and Exotel's applet JSON,
 * so the provider knows which agent to bridge to.
 */
webhooksRouter.post('/telephony/:provider/incoming', asyncHandler(async (req, res) => {
  const body = req.body as Record<string, string>;
  const from = body.From ?? body.CallFrom ?? body.from ?? '';
  const to = body.To ?? body.CallTo ?? body.To ?? '';
  const providerCallId = body.CallSid ?? body.CallUuid ?? body.Sid ?? crypto.randomUUID();

  if (!from) throw new BadRequestError('Missing caller number');

  const routing = await routeInboundCall({ from, to, providerCallId, provider: req.params.provider });

  if (req.params.provider === 'twilio') {
    const dial = routing.routeToNumber
      ? `<Dial timeout="25" record="record-from-answer-dual"><Number>${escapeXml(routing.routeToNumber)}</Number></Dial>`
      : `<Say voice="alice">Thank you for calling. All our advisors are busy. We will call you back shortly.</Say>`;
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${dial}</Response>`);
    return;
  }

  res.json({
    select: routing.routeToNumber ? 'agent' : 'voicemail',
    destination: routing.routeToNumber,
    callId: routing.callId,
    knownContact: routing.isKnownContact,
    contactName: routing.recordLabel,
  });
}));

/** Screen-pop: the softphone polls this to know who is calling. */
webhooksRouter.get('/telephony/lookup', asyncHandler(async (req, res) => {
  const number = String(req.query.number ?? '');
  if (!number) throw new BadRequestError('number is required');
  const tail = number.replace(/\D/g, '').slice(-10);

  const row = await db.queryOne(
    `SELECT r.id, r.label, r.module_name, r.owner_id
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE r.is_deleted = false AND right(regexp_replace(COALESCE(l.mobile,''), '\\D','','g'), 10) = $1
     ORDER BY CASE l.lifecycle_stage WHEN 'Customer' THEN 0 WHEN 'Prospect' THEN 1 ELSE 2 END
     LIMIT 1`,
    [tail],
  );
  res.json(row ?? { found: false });
}));

// ---------------------------------------------------------------------------
// Lead sources
// ---------------------------------------------------------------------------

webhooksRouter.get('/leads/facebook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === getSettings().leadSources.facebook.verifyToken) {
    res.status(200).send(req.query['hub.challenge']);
    return;
  }
  res.sendStatus(403);
});

webhooksRouter.post('/leads/facebook', asyncHandler(async (req, res) => {
  res.sendStatus(200);

  const body = req.body as {
    entry?: { changes?: { value?: { leadgen_id?: string; form_id?: string; page_id?: string; campaign_id?: string } }[] }[];
  };

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const leadgenId = change.value?.leadgen_id;
      if (!leadgenId) continue;
      try {
        // Meta only sends the id; the field data has to be fetched.
        const token = getSettings().leadSources.facebook.pageAccessToken;
        if (!token) {
          logger.warn('facebook lead received but no page access token is configured');
          continue;
        }
        const res2 = await fetch(
          `https://graph.facebook.com/v21.0/${leadgenId}?access_token=${token}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        const detail = await res2.json() as Parameters<typeof normalizeFacebook>[0];
        await captureLead('facebook', detail, normalizeFacebook({ ...detail, ...change.value }), {
          externalId: leadgenId,
        });
      } catch (err) {
        logger.error({ err, leadgenId }, 'facebook lead capture failed');
      }
    }
  }
}));

webhooksRouter.post('/leads/google', asyncHandler(async (req, res) => {
  const body = req.body as { google_key?: string; lead_id?: string };
  const { googleAdsWebhookKey } = getSettings().leadSources;
  if (googleAdsWebhookKey && body.google_key !== googleAdsWebhookKey) {
    throw new UnauthorizedError('Invalid webhook key');
  }
  res.sendStatus(200);

  await captureLead('google_ads', body, normalizeGoogleAds(body as never), { externalId: body.lead_id })
    .catch((err) => logger.error({ err }, 'google lead capture failed'));
}));

/** Generic portal endpoint: /webhooks/leads/portal/99acres, /magicbricks, … */
webhooksRouter.post('/leads/portal/:portal', asyncHandler(async (req, res) => {
  const portalMap: Record<string, string> = {
    '99acres': '99acres', magicbricks: 'MagicBricks', housing: 'Housing.com',
    nobroker: 'NoBroker', commonfloor: 'CommonFloor', proptiger: 'PropTiger',
  };
  const source = portalMap[req.params.portal.toLowerCase()] ?? req.params.portal;

  res.status(200).json({ received: true });

  await captureLead(source, req.body, normalizePortal(source, req.body as Record<string, unknown>))
    .catch((err) => logger.error({ err, source }, 'portal lead capture failed'));
}));

// ---------------------------------------------------------------------------
// Web forms (embeddable on a landing page)
// ---------------------------------------------------------------------------

webhooksRouter.get('/forms/:publicKey', asyncHandler(async (req, res) => {
  const form = await db.queryOne<{ id: string; name: string; fields: unknown; success_message: string | null; captcha_enabled: boolean }>(
    `SELECT id, name, fields, success_message, captcha_enabled FROM ipy_webform WHERE public_key = $1 AND is_active`,
    [req.params.publicKey],
  );
  if (!form) throw new NotFoundError('Form not found');
  res.json(form);
}));

webhooksRouter.post('/forms/:publicKey', asyncHandler(async (req, res) => {
  const form = await db.queryOne<{
    id: string; module_id: string; fields: { name: string; label: string }[];
    defaults: Record<string, unknown>; assign_to_user_id: string | null;
    redirect_url: string | null; success_message: string | null;
    allowed_origins: string[]; notify_user_ids: string[];
  }>(
    `SELECT id, module_id, fields, defaults, assign_to_user_id, redirect_url,
            success_message, allowed_origins, notify_user_ids
     FROM ipy_webform WHERE public_key = $1 AND is_active`,
    [req.params.publicKey],
  );
  if (!form) throw new NotFoundError('Form not found');

  // Origin allow-list, when configured.
  const origin = req.headers.origin;
  if (form.allowed_origins?.length && origin && !form.allowed_origins.includes(origin)) {
    throw new UnauthorizedError('This origin is not allowed to submit this form');
  }

  const payload = req.body as Record<string, unknown>;
  const normalized: NormalizedLead = {
    firstName: String(payload.first_name ?? payload.firstName ?? String(payload.name ?? '').split(' ')[0] ?? 'Website'),
    lastName: String(payload.last_name ?? payload.lastName ?? String(payload.name ?? '').split(' ').slice(1).join(' ') ?? ''),
    email: payload.email ? String(payload.email) : undefined,
    mobile: String(payload.mobile ?? payload.phone ?? ''),
    source: String(form.defaults?.lead_source ?? 'Website'),
    subSource: form.defaults?.sub_source ? String(form.defaults.sub_source) : undefined,
    message: payload.message ? String(payload.message) : undefined,
    // What the visitor picked wins over the form's own default.
    projectName: payload.project
      ? String(payload.project)
      : form.defaults?.interested_project ? String(form.defaults.interested_project) : undefined,
    landingPage: payload.page_url ? String(payload.page_url) : (req.headers.referer as string | undefined),
    ipAddress: req.ip,
    utm: {
      utm_source: String(payload.utm_source ?? ''),
      utm_medium: String(payload.utm_medium ?? ''),
      utm_campaign: String(payload.utm_campaign ?? ''),
      utm_term: String(payload.utm_term ?? ''),
      utm_content: String(payload.utm_content ?? ''),
      gclid: String(payload.gclid ?? ''),
      fbclid: String(payload.fbclid ?? ''),
    },
  };

  const result = await captureLead('webform', payload, normalized, {
    ownerId: form.assign_to_user_id ?? undefined,
  });

  await db.query(`UPDATE ipy_webform SET submission_count = submission_count + 1 WHERE id = $1`, [form.id]);

  for (const userId of form.notify_user_ids ?? []) {
    await db.query(
      `INSERT INTO ipy_notification (user_id, kind, title, body, link, record_id)
       VALUES ($1,'webform','New form submission',$2,$3,$4)`,
      [userId, `${normalized.firstName} — ${normalized.mobile}`, result.recordId ? `/leads/${result.recordId}` : '/leads', result.recordId],
    );
  }

  res.json({
    ok: result.status !== 'failed',
    message: form.success_message ?? 'Thank you — our team will contact you shortly.',
    redirectUrl: form.redirect_url,
  });
}));

// ---------------------------------------------------------------------------
// Email tracking pixel
// ---------------------------------------------------------------------------

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

webhooksRouter.get('/email/open/:trackingId.gif', asyncHandler(async (req, res) => {
  void recordOpen(req.params.trackingId).catch(() => undefined);
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  });
  res.send(PIXEL);
}));

// ---------------------------------------------------------------------------
// Generic inbound webhook (bring your own source)
// ---------------------------------------------------------------------------

webhooksRouter.post('/leads/generic', asyncHandler(async (req, res) => {
  const key = req.headers['x-webform-key'];
  if (key !== getSettings().leadSources.webformPublicKey) throw new UnauthorizedError('Invalid webhook key');

  const input = z.object({
    firstName: z.string().min(1),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    mobile: z.string().min(6),
    source: z.string().default('Website'),
    message: z.string().optional(),
    projectName: z.string().optional(),
    budgetMax: z.number().optional(),
    configuration: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
    externalId: z.string().optional(),
  }).parse(req.body);

  const result = await captureLead('generic', req.body, input as NormalizedLead, { externalId: input.externalId });
  res.status(result.status === 'created' ? 201 : 200).json(result);
}));

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c
  ));
}
