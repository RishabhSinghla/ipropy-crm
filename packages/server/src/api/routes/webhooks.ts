/**
 * Public webhook endpoints.
 *
 * Deliberately mounted before the auth middleware — every handler authenticates
 * on its own terms (signature verification, verify tokens, or a public form key)
 * and returns 200 quickly so providers don't retry.
 */
import express, { Router, type Request } from 'express';
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
import { notifyMany } from '../../core/notifications/index.js';

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

  // Speed of first response is the biggest controllable factor in conversion,
  // and a website enquiry lands when nobody is at a desk. This is the alert
  // that most needs to reach a phone.
  await notifyMany(form.notify_user_ids ?? [], {
    kind: 'webform',
    title: 'New form submission',
    body: `${normalized.firstName} — ${normalized.mobile}`,
    link: result.recordId ? `/leads/${result.recordId}` : '/leads',
    recordId: result.recordId,
  });

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

// ---------------------------------------------------------------------------
// n8n — the content factory reporting back
// ---------------------------------------------------------------------------

/**
 * n8n has finished working on a property's photos.
 *
 * This router is mounted ahead of `requireAuth`, so every route on it must
 * authenticate itself. Here that is a shared secret in `X-N8N-Secret`, compared
 * in constant time. **An unset secret refuses everything** rather than allowing
 * everything: this endpoint raises notifications, and an open one is a stranger
 * pushing "your content is ready" at the whole team.
 *
 * Nothing here writes to the property. n8n's output lives in OneDrive beside
 * the photos, and a model's opinion about which pictures are good has no
 * business editing inventory unasked. All this does is tell the right person to
 * go and look.
 */
webhooksRouter.post('/n8n/content-ready', asyncHandler(async (req, res) => {
  const expected = getSettings().automation.n8nCallbackSecret;
  if (!expected) throw new UnauthorizedError('n8n callbacks are not configured');

  const provided = req.headers['x-n8n-secret'];
  if (typeof provided !== 'string' || !safeEqual(expected, provided)) {
    throw new UnauthorizedError('Invalid n8n secret');
  }

  const input = z.object({
    propertyId: z.string().uuid(),
    sessionId: z.string().uuid().optional(),
    folder: z.string().max(400).optional(),
    summary: z.string().max(400).optional(),
    // n8n sends this when a run failed partway. The team still wants telling —
    // silence is indistinguishable from "not started yet".
    ok: z.boolean().default(true),
  }).parse(req.body);

  const property = await db.queryOne<{ label: string; owner_id: string | null }>(
    `SELECT r.label, r.owner_id
       FROM ipy_record r
      WHERE r.id = $1 AND r.module_name = 'properties' AND r.is_deleted = false`,
    [input.propertyId],
  );
  if (!property) throw new NotFoundError('Property not found');

  // The owner, plus whoever actually walked the site if that was someone else.
  const recipients: string[] = [];
  if (property.owner_id) recipients.push(property.owner_id);
  if (input.sessionId) {
    const session = await db.queryOne<{ user_id: string }>(
      `SELECT user_id FROM ipy_shoot_session WHERE id = $1`, [input.sessionId],
    );
    if (session) recipients.push(session.user_id);
  }
  if (recipients.length === 0) {
    logger.warn({ propertyId: input.propertyId }, 'n8n finished but the property has no owner to tell');
    res.json({ ok: true, notified: 0 });
    return;
  }

  await notifyMany(recipients, {
    kind: 'content_ready',
    title: input.ok
      ? `Photos are ready for ${property.label}`
      : `Photo processing had a problem on ${property.label}`,
    body: input.summary ?? (input.ok ? 'Open the OneDrive folder to review.' : 'Check _status.json in the folder.'),
    link: `/properties/${input.propertyId}`,
    recordId: input.propertyId,
  });

  logger.info(
    { propertyId: input.propertyId, notified: recipients.length, ok: input.ok },
    'n8n content-ready callback handled',
  );
  res.json({ ok: true, notified: new Set(recipients).size });
}));

// ---------------------------------------------------------------------------
// The WhatsApp bridge
//
// A small process on an always-on machine holds the linked WhatsApp sessions
// and talks to the CRM through these five endpoints. It lives out there rather
// than in here for the same reason the media worker does: the session must
// survive a redeploy, and a container Render restarts at will cannot hold one.
//
// The traffic is one-way by design. The bridge always calls the CRM; the CRM
// never calls the bridge. That means the machine holding the sessions needs no
// public address, no tunnel and no open port, which removes the entire question
// of exposing a laptop to the internet.
// ---------------------------------------------------------------------------

/** Every bridge call proves it is the bridge. No token configured, no entry. */
function assertBridge(req: Request): void {
  const expected = getSettings().whatsappLinked.bridgeToken;
  if (!expected) throw new UnauthorizedError('The WhatsApp bridge is not configured');
  const provided = req.headers['x-bridge-token'];
  if (typeof provided !== 'string' || !safeEqual(expected, provided)) {
    throw new UnauthorizedError('Invalid bridge token');
  }
}

/**
 * The bridge's one repeated question: what should I be doing?
 *
 * Answers with the sessions it should be holding and at most one message per
 * number to send. One, because the gap between messages is enforced here and a
 * batch would hand that decision to a process that forgets everything when it
 * restarts. See integrations/whatsapp/linkedDevice.ts.
 */
webhooksRouter.post('/wa-bridge/poll', asyncHandler(async (req, res) => {
  assertBridge(req);

  const { claimOutbox, linksForBridge, touchSeen, releaseStaleClaims } =
    await import('../../integrations/whatsapp/linkedDevice.js');

  // Anything a previous bridge claimed and never reported on goes back in the
  // queue. Done on the poll rather than on a timer so it needs no scheduler
  // entry, and a bridge that has been off all night finds a clean queue.
  await releaseStaleClaims();

  const links = await linksForBridge();
  await touchSeen(links.map((l) => l.id));

  const claim = await claimOutbox();

  res.json({
    links: links.map((l) => ({
      id: l.id,
      status: l.status,
      handle: l.handle,
      label: l.label,
      userName: l.userName,
    })),
    outbox: claim.messages,
    retryAfterSeconds: claim.retryAfterSeconds,
    ...(claim.idleReason ? { idleReason: claim.idleReason } : {}),
  });
}));

/** A fresh pairing code, on its way to the settings screen the rep is watching. */
webhooksRouter.post('/wa-bridge/qr', asyncHandler(async (req, res) => {
  assertBridge(req);
  const input = z.object({
    linkId: z.string().uuid(),
    // A rendered PNG data URI, not the raw pairing string. The bridge already
    // has to handle that string, so it draws the image too and neither the API
    // nor the web bundle gains a QR library for one screen.
    qr: z.string().min(1).max(40_000),
  }).parse(req.body);

  const { setQr } = await import('../../integrations/whatsapp/linkedDevice.js');
  await setQr(input.linkId, input.qr);
  res.json({ ok: true });
}));

/** Connected, or gone. Both are worth knowing the moment they happen. */
webhooksRouter.post('/wa-bridge/state', asyncHandler(async (req, res) => {
  assertBridge(req);
  const input = z.object({
    linkId: z.string().uuid(),
    status: z.enum(['connected', 'logged_out']),
    handle: z.string().max(32).optional(),
    error: z.string().max(500).optional(),
  }).parse(req.body);

  const { markConnected, markLoggedOut } = await import('../../integrations/whatsapp/linkedDevice.js');
  if (input.status === 'connected') {
    if (!input.handle) throw new BadRequestError('A connected link must report its number');
    await markConnected(input.linkId, input.handle);
  } else {
    await markLoggedOut(input.linkId, input.error ?? null);
  }
  res.json({ ok: true });
}));

/** What happened to a message the bridge was handed. */
webhooksRouter.post('/wa-bridge/result', asyncHandler(async (req, res) => {
  assertBridge(req);
  const input = z.object({
    sendId: z.string().uuid(),
    ok: z.boolean(),
    error: z.string().max(500).optional(),
    providerMessageId: z.string().max(200).optional(),
  }).parse(req.body);

  const { reportResult } = await import('../../integrations/whatsapp/linkedDevice.js');
  await reportResult({
    sendId: input.sendId,
    ok: input.ok,
    error: input.error ?? null,
    providerMessageId: input.providerMessageId ?? null,
  });
  res.json({ ok: true });
}));

/**
 * A customer wrote back.
 *
 * Handed to the same `handleInbound` the Meta webhook uses, which is the reason
 * this whole channel was worth building on top of the existing one rather than
 * beside it: the 24-hour window, opt-out detection, sequence exit on reply,
 * auto-replies, the SLA clock and the record timeline all keep working without
 * knowing which door the message came through.
 */
webhooksRouter.post('/wa-bridge/inbound', asyncHandler(async (req, res) => {
  assertBridge(req);
  const input = z.object({
    from: z.string().min(6).max(32),
    providerMessageId: z.string().max(200),
    type: z.string().max(40).default('text'),
    text: z.string().max(8000).optional(),
    caption: z.string().max(2000).optional(),
    mediaId: z.string().max(200).optional(),
    mimeType: z.string().max(200).optional(),
    filename: z.string().max(300).optional(),
    timestamp: z.number().int().positive().optional(),
    profileName: z.string().max(200).optional(),
  }).parse(req.body);

  // A message the CRM already has is not an error. WhatsApp redelivers on
  // reconnect, and a bridge restarting mid-conversation would otherwise file
  // the same reply twice, re-open the window twice and fire the auto-reply
  // twice at somebody who wrote once.
  const seen = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_message WHERE provider_message_id = $1 LIMIT 1`,
    [input.providerMessageId],
  );
  if (seen) {
    res.json({ ok: true, duplicate: true });
    return;
  }

  const result = await waService.handleInbound({ ...input, provider: 'linked' });
  res.json({ ok: true, ...result });
}));

/**
 * The bytes behind an inbound photo, voice note, video or document.
 *
 * A second call rather than part of `/inbound`, and deliberately so. The
 * message is what matters: it must land, be deduplicated and fire the
 * auto-reply whether or not a 40MB video transfers. So the text arrives first
 * and the file follows, and a failure here costs the picture, never the
 * message.
 *
 * Raw body, not base64 in JSON. Base64 inflates by a third and would have to be
 * held as a string in memory before it could be decoded; `express.raw` hands
 * over a Buffer that goes straight to the storage driver. The global JSON
 * parser ignores this route because the bridge sends octet-stream.
 */
webhooksRouter.post(
  '/wa-bridge/media',
  express.raw({ type: '*/*', limit: '64mb' }),
  asyncHandler(async (req, res) => {
    assertBridge(req);

    const messageId = z.string().uuid().parse(req.query.messageId);
    const mimeType = z.string().max(200).default('application/octet-stream')
      .parse(req.query.mimeType ?? 'application/octet-stream');
    const fileName = z.string().max(300).optional().parse(req.query.fileName || undefined);

    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new BadRequestError('No file content was sent');
    }

    const message = await db.queryOne<{ id: string; conversation_id: string; media: Record<string, unknown> | null }>(
      `SELECT id, conversation_id, media FROM ipy_message WHERE id = $1`,
      [messageId],
    );
    if (!message) throw new NotFoundError('No such message');

    const { getDriver } = await import('../../core/storage/index.js');
    const driver = await getDriver();
    const key = `whatsapp/${message.conversation_id}/${messageId}${extensionFor(mimeType, fileName)}`;
    await driver.save(key, bytes, mimeType);

    // Merged into whatever `/inbound` already recorded, so the caption and the
    // type it wrote survive. `storageKey` is the flag the thread reads to know
    // the file is really here rather than merely announced.
    await db.query(
      `UPDATE ipy_message
          SET media = COALESCE(media, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [
        messageId,
        JSON.stringify({
          storageKey: key,
          mimeType,
          size: bytes.length,
          ...(fileName ? { fileName } : {}),
        }),
      ],
    );

    logger.info({ messageId, bytes: bytes.length, mimeType }, 'stored inbound WhatsApp media');
    res.json({ ok: true });
  }),
);

/**
 * Chats that already existed on the phone before it was linked.
 *
 * Emphatically **not** `/inbound`. That path is for a message arriving now, and
 * it does eight other things: bumps the unread count, re-opens the 24-hour
 * window, starts the SLA response clock, notifies the owner, exits the lead
 * from its sequences, records consent keywords and fires the auto-reply.
 * Running a year of old conversations through it would text every one of his
 * customers an automatic reply to something they said in March, mark hundreds
 * of threads unread and re-open windows that closed months ago. History is a
 * record of what happened, so it is written and nothing else.
 *
 * Every one-to-one chat is kept, not only numbers already in the CRM. That was
 * the other way round until he saw the result: 821 chats offered, 2 kept,
 * because a filter matching against three leads discards a phone. Chats with
 * strangers still resolve to no record, so they sit in WhatsApp and touch no
 * lead's timeline — they are conversations, not CRM data.
 *
 * Groups are still dropped, in the bridge. A group is not a person, filing one
 * against a record puts a dozen strangers' words on somebody's timeline, and
 * nothing downstream knows what to do with many senders in one thread.
 */
webhooksRouter.post('/wa-bridge/history', asyncHandler(async (req, res) => {
  assertBridge(req);

  const input = z.object({
    /** Whose phone this history came off, so a private chat can be scoped to them. */
    linkId: z.string().uuid().optional(),
    messages: z.array(z.object({
      from: z.string().min(6).max(32),
      providerMessageId: z.string().max(200),
      direction: z.enum(['inbound', 'outbound']),
      type: z.string().max(40).default('text'),
      text: z.string().max(8000).optional(),
      mimeType: z.string().max(200).optional(),
      filename: z.string().max(300).optional(),
      timestamp: z.number().int().positive(),
      /** What the phone calls this person, used when they are not a lead. */
      name: z.string().max(200).optional(),
    })).max(500),
  }).parse(req.body);

  // Who this phone belongs to. A chat that matches no CRM record is that
  // person's private life, not shared inbox material, so it is scoped to them
  // rather than left unassigned — which the conversation list shows to
  // everybody.
  const owner = input.linkId
    ? (await db.queryOne<{ user_id: string }>(
        `SELECT user_id FROM ipy_wa_link WHERE id = $1`, [input.linkId],
      ))?.user_id ?? null
    : null;

  let imported = 0;
  let duplicate = 0;

  for (const m of input.messages) {
    const seen = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_message WHERE provider_message_id = $1 LIMIT 1`,
      [m.providerMessageId],
    );
    if (seen) { duplicate += 1; continue; }

    const conversationId = await waService.getOrCreateConversation(m.from);
    const at = new Date(m.timestamp * 1000);

    // Only ever set, never cleared: a thread that later matches a lead becomes
    // business and stops being private, but one that was business already must
    // not be hidden because a batch arrived without a record resolving.
    if (owner) {
      await db.query(
        `UPDATE ipy_conversation
            SET private_to_user_id = CASE WHEN record_id IS NULL THEN $2 ELSE NULL END
          WHERE id = $1`,
        [conversationId, owner],
      );
    }

    // A number that is not a lead has no name in the CRM, so the thread would
    // read as raw digits. The phone knows what to call them, so use that —
    // only to fill a blank, never to overwrite a name the CRM already has,
    // which is somebody's own record and outranks a phone's address book.
    if (m.name) {
      await db.query(
        `UPDATE ipy_conversation SET contact_name = $2
          WHERE id = $1 AND (contact_name IS NULL OR contact_name = '')`,
        [conversationId, m.name],
      );
    }

    await db.query(
      `INSERT INTO ipy_message
         (conversation_id, direction, channel, type, body, status,
          provider_message_id, provider, created_at, delivered_at, sent_via)
       VALUES ($1,$2,'whatsapp',$3,$4,$5,$6,'linked',$7,$7,'linked')`,
      [
        conversationId,
        m.direction,
        m.type,
        m.text ?? null,
        // An old outbound message did leave, and an old inbound one did arrive.
        // 'queued' would put a clock on a message from last year. 'delivered'
        // is what the live inbound path writes, so the ticks match.
        m.direction === 'outbound' ? 'sent' : 'delivered',
        m.providerMessageId,
        at,
      ],
    );
    imported += 1;

    // Only ever moves the preview forward. History arrives in whatever order
    // the phone hands it over, and a conversation whose last line is from
    // March because that batch landed last is worse than no history at all.
    await db.query(
      `UPDATE ipy_conversation
          SET last_message_at = GREATEST(COALESCE(last_message_at, $2::timestamptz), $2::timestamptz),
              last_message_preview = CASE
                WHEN last_message_at IS NULL OR last_message_at <= $2::timestamptz
                THEN $3 ELSE last_message_preview END
        WHERE id = $1`,
      [conversationId, at, (m.text ?? `[${m.type}]`).slice(0, 200)],
    );
  }

  if (imported) logger.info({ imported, duplicate }, 'imported WhatsApp history');
  res.json({ ok: true, imported, duplicate });
}));

/** Keeps a recognisable extension on the stored object, without trusting one. */
function extensionFor(mimeType: string, fileName?: string): string {
  const fromName = fileName?.match(/(\.[A-Za-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  const known: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
    'audio/ogg': '.ogg', 'application/pdf': '.pdf',
  };
  return known[mimeType.split(';')[0]!.trim()] ?? '';
}

/**
 * Constant-time compare that tolerates a length mismatch.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length, and that
 * throw is itself a signal — so both sides are hashed to a fixed width first.
 */
function safeEqual(expected: string, provided: string): boolean {
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c
  ));
}
