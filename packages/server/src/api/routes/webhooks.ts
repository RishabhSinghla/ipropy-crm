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
import { complete } from '../../ai/client.js';
import { aiModels, mediaAiStatus, music, speak } from '../../ai/media.js';
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
/** Same secret as the content-ready callback, checked the same way. */
function requireN8nSecret(req: Request): void {
  const expected = getSettings().automation.n8nCallbackSecret;
  if (!expected) throw new UnauthorizedError('n8n callbacks are not configured');
  const provided = req.headers['x-n8n-secret'];
  if (typeof provided !== 'string' || !safeEqual(expected, provided)) {
    throw new UnauthorizedError('Invalid n8n secret');
  }
}

/**
 * The work n8n cannot be told about, so it comes and asks.
 *
 * The CRM runs on Render and n8n runs on somebody's Mac behind a home router,
 * which means the CRM can never open a connection to it. Every "the CRM will
 * call n8n" design dies on that fact, including the Finish button, which only
 * works today because both happen to be on one laptop.
 *
 * So the arrow is reversed. n8n asks what needs doing on a timer, does it, and
 * says so. No tunnel, no port forwarding, nothing of his exposed to the
 * internet — and the folder gets made on the one machine that can actually
 * write to his OneDrive.
 *
 * Returns the folder name the CRM has already decided on, never lets n8n choose
 * it: the name is derived from the record number and label and is what every
 * uploaded file's storage key is built from. If the two ever disagreed, media
 * would land in a folder nothing reads.
 */
webhooksRouter.get('/n8n/pending-folders', asyncHandler(async (req, res) => {
  requireN8nSecret(req);

  const { rows } = await db.query<{ record_id: string; folder_key: string | null; module_name: string; label: string; record_number: string | null }>(
    `SELECT s.record_id, s.folder_key, r.module_name, r.label, r.record_number
       FROM ipy_property_storage s
       JOIN ipy_record r ON r.id = s.record_id
      WHERE (s.onedrive_folder_at IS NULL OR s.onedrive_folder_at < r.updated_at)
        AND r.is_deleted = false
        -- Once photos have reached the record, stop touching the folder at all.
        --
        -- The folder is the team's after the handover: theirs to rename, empty
        -- or reorganise. A details file quietly reappearing in a folder
        -- somebody has tidied is the software arguing with them, and it makes
        -- the boundary conditional when the whole point is that it is not.
        AND NOT EXISTS (
          SELECT 1 FROM ipy_attachment a
           WHERE a.record_id = r.id AND a.mime_type LIKE 'image/%'
        )
      ORDER BY s.created_at
      LIMIT 50`,
  );

  const { recordStorageRoot, propertyFolderTree, propertyFolderKey, unitFromFolderName } =
    await import('../../core/storage/keys.js');
  const { buildPropertyDetailsText, buildDescriptions, DETAILS_FILE, DESCRIPTIONS_FILE } =
    await import('../../core/storage/propertyDetails.js');

  res.json({
    folders: await Promise.all(rows.map(async (row) => {
      // Worked out once. It was computed three times below from the same
      // inputs, which is three chances for one of them to drift and for the
      // details file to be named after a folder nobody made.
      const folder = row.folder_key
        ?? (await propertyFolderKey(row.record_id))
        ?? recordStorageRoot(row.module_name, row.record_number, row.label, row.record_id);
      const unit = unitFromFolderName(folder);
      return {
      propertyId: row.record_id,
      folder,
      subfolders: propertyFolderTree(unit),
      // The sheet travels with the folder request rather than being written by
      // the CRM, because only n8n can reach the drive these folders live on.
      detailsPath: `${unit}-${DETAILS_FILE}`,
      detailsText: (await buildPropertyDetailsText(row.record_id)) ?? '',
      // At the property root, because it answers the question somebody has the
      // moment they open the folder. Named after the unit so it is still
      // obvious which property it belongs to once it has been dragged
      // somewhere else.
      wherePath: `${unit}-${DESCRIPTIONS_FILE}`,
      whereText: await buildDescriptions(row.record_id),
      };
    })),
  });
}));

/**
 * Properties somebody pressed Finish on that n8n has not processed yet.
 *
 * Same reversed arrow as the folders. The webhook still fires when the two can
 * see each other, which keeps it instant on a laptop; this is what makes it
 * arrive at all in production.
 */
webhooksRouter.get('/n8n/pending-media', asyncHandler(async (req, res) => {
  requireN8nSecret(req);

  const { rows } = await db.query<{ record_id: string; folder_key: string }>(
    `SELECT s.record_id, s.folder_key
       FROM ipy_property_storage s
       JOIN ipy_record r ON r.id = s.record_id
      WHERE s.media_requested_at IS NOT NULL
        AND (s.media_done_at IS NULL OR s.media_done_at < s.media_requested_at)
        AND s.folder_key IS NOT NULL
        AND r.is_deleted = false
      ORDER BY s.media_requested_at
      LIMIT 10`,
  );

  const { propertyNamePrefix } = await import('../../integrations/automation/n8n.js');
  const { propertyFacts } = await import('../../core/storage/propertyDetails.js');
  res.json({
    // Facts travel with the job. The worker has the pixels and the CRM has the
    // price, the configuration and the locality; a caption needs both, and
    // sending them together is cheaper than a second round trip per property.
    properties: await Promise.all(rows.map(async (r) => ({
      propertyId: r.record_id,
      folder: r.folder_key,
      namePrefix: await propertyNamePrefix(r.record_id),
      facts: await propertyFacts(r.record_id),
    }))),
  });
}));

/**
 * AI for the media worker, through the CRM's own key.
 *
 * The worker renders pixels and knows nothing else. It could hold an OpenRouter
 * key of its own, and that is exactly the trap this project keeps finding: two
 * copies of one setting, one of them editable, quietly disagreeing. The key
 * lives in Admin → Integrations, where an admin can rotate it or switch
 * provider, and the worker borrows it over the channel it already trusts.
 *
 * Guarded by the same n8n secret as everything else here, and deliberately not
 * a general proxy: three named jobs with fixed shapes, so a leaked secret buys
 * an attacker some captions rather than an open relay to any model.
 */
const visionSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  system: z.string().max(8_000).optional(),
  // Eight at a time keeps a batch inside the 5MB body limit at the ~200KB
  // preview size the worker sends. More than that and the request is refused
  // rather than silently truncated.
  images: z.array(z.object({
    data: z.string().min(1),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
  })).max(8).default([]),
  maxTokens: z.number().int().min(64).max(16_000).optional(),
  recordId: z.string().uuid().optional(),
});

webhooksRouter.post('/n8n/ai/vision', asyncHandler(async (req, res) => {
  requireN8nSecret(req);
  const input = visionSchema.parse(req.body);

  // Photographs go to the vision model, plain questions to the copy model. Two
  // settings rather than one, because reading a picture and writing a paragraph
  // are different jobs with very different prices.
  const { modelFor } = await import('../../core/settings/aiModels.js');
  const result = await complete({
    feature: 'property_vision',
    model: await modelFor(input.images.length ? 'vision' : 'copy'),
    system: input.system ?? 'You are a property photographer and marketer. Answer only with the JSON asked for.',
    prompt: input.prompt,
    // No pictures is a normal call, not an empty one: the pass that writes the
    // listing copy reasons over the notes the photo pass already produced.
    ...(input.images.length
      ? { images: input.images.map((i) => ({ data: Buffer.from(i.data, 'base64'), mimeType: i.mimeType })) }
      : {}),
    maxTokens: input.maxTokens ?? 4000,
    temperature: 0.2,
    recordId: input.recordId ?? null,
  });

  // 200 with `ok: false` rather than a 5xx: the worker has photos to process
  // either way, and a failed caption must not read to n8n as a failed property.
  if (!result) {
    res.json({ ok: false, reason: 'No AI provider answered. Check Admin → Integrations.' });
    return;
  }
  res.json({ ok: true, text: result.text, model: result.model });
}));

webhooksRouter.post('/n8n/ai/speech', asyncHandler(async (req, res) => {
  requireN8nSecret(req);
  const input = z.object({
    text: z.string().min(1).max(8_000),
    voice: z.string().max(60).optional(),
    format: z.enum(['mp3', 'wav', 'opus']).default('mp3'),
    speed: z.number().min(0.5).max(1.5).optional(),
    model: z.string().max(120).optional(),
    recordId: z.string().uuid().optional(),
  }).parse(req.body);

  const audio = await speak({
    text: input.text,
    voice: input.voice,
    format: input.format,
    speed: input.speed,
    model: input.model,
    recordId: input.recordId ?? null,
  });
  if (!audio) {
    res.json({ ok: false, reason: mediaAiStatus().reason ?? 'The voice model did not answer.' });
    return;
  }
  // Base64 in JSON rather than raw bytes, so one failure shape covers both
  // outcomes and the worker never has to sniff a content type to find out
  // whether it got audio or an apology.
  res.json({ ok: true, format: input.format, audio: audio.toString('base64') });
}));

webhooksRouter.post('/n8n/ai/music', asyncHandler(async (req, res) => {
  requireN8nSecret(req);
  const input = z.object({
    brief: z.string().min(1).max(2_000),
    seconds: z.number().int().min(5).max(120).default(30),
    model: z.string().max(120).optional(),
    recordId: z.string().uuid().optional(),
  }).parse(req.body);

  const audio = await music(input.brief, {
    seconds: input.seconds,
    model: input.model,
    recordId: input.recordId ?? null,
  });
  if (!audio) {
    res.json({ ok: false, reason: mediaAiStatus().reason ?? 'The music model did not answer.' });
    return;
  }
  res.json({ ok: true, format: 'mp3', audio: audio.toString('base64') });
}));

/** What the worker can expect to work before it starts a long job. */
webhooksRouter.get('/n8n/ai/status', asyncHandler(async (req, res) => {
  requireN8nSecret(req);
  res.json({ ...mediaAiStatus(), models: await aiModels() });
}));

/**
 * How this business sounds, fetched rather than hardcoded in the worker.
 *
 * The prompts in the media scripts carry the *task*: describe this room, write
 * a caption, write a voiceover. What they must not carry is the *voice* — the
 * tone, the language, the one rule about never describing furniture that is not
 * there. That lives in Admin → Settings, and a worker that copied it would be a
 * second version to go stale.
 */
webhooksRouter.get('/n8n/ai/style', asyncHandler(async (req, res) => {
  requireN8nSecret(req);
  const { houseStyle } = await import('../../core/settings/houseStyle.js');
  const { aiFeatures } = await import('../../core/settings/aiFeatures.js');
  const { db: conn } = await import('../../db/pool.js');
  const floor = await conn.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'media.photo_score_floor'`,
  );
  res.json({
    style: await houseStyle(),
    features: await aiFeatures(),
    photoScoreFloor: Number(floor?.value ?? 4),
  });
}));

/** n8n made the folders on disk; record that so the CRM stops asking. */
webhooksRouter.post('/n8n/folder-ready', asyncHandler(async (req, res) => {
  requireN8nSecret(req);

  const input = z.object({
    propertyId: z.string().uuid(),
    folder: z.string().min(1).max(400),
    ok: z.boolean().default(true),
    error: z.string().max(400).optional(),
  }).parse(req.body);

  await db.query(
    // Only the OneDrive marker moves. status and provisioned_driver belong to
    // the CRM's own worker, and writing them here is what would set the two
    // fighting over the same row.
    `UPDATE ipy_property_storage
        SET onedrive_folder_at = CASE WHEN $2 THEN now() ELSE onedrive_folder_at END,
            folder_key = COALESCE(folder_key, $3),
            last_error = $4,
            updated_at = now()
      WHERE record_id = $1`,
    [input.propertyId, input.ok, input.folder, input.ok ? null : (input.error ?? 'n8n could not create the folder')],
  );

  res.json({ ok: true });
}));

webhooksRouter.post('/n8n/content-ready', asyncHandler(async (req, res) => {
  const expected = getSettings().automation.n8nCallbackSecret;
  if (!expected) throw new UnauthorizedError('n8n callbacks are not configured');

  const provided = req.headers['x-n8n-secret'];
  if (typeof provided !== 'string' || !safeEqual(expected, provided)) {
    throw new UnauthorizedError('Invalid n8n secret');
  }

  const input = z.object({
    propertyId: z.string().uuid(),
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

  // Decide whether this call is the one that gets to tell anybody.
  //
  // The owner's phone got eight "photos are ready" alerts for one property.
  // Both entry paths can pick up the same property, and pressing Finish twice
  // after adding photos is ordinary use, so every run was buzzing him again. An
  // alert that fires eight times is an alert people switch off.
  //
  // Suppressing repeats is not the same as going quiet. A failure arriving
  // after a success is new information and must always get through, and so must
  // a recovery — silence there is indistinguishable from never having started.
  // So the test is whether the *outcome* changed, using last_error as the record
  // of what was last reported, not merely whether we have reported before.
  //
  // The WHERE clause does the deciding rather than a read-then-write, so two
  // runs finishing together end up with exactly one of them notifying.
  const prior = await db.queryOne<{ had_error: boolean; already: boolean }>(
    `SELECT last_error IS NOT NULL AS had_error,
            (media_done_at IS NOT NULL AND media_done_at >= media_requested_at) AS already
       FROM ipy_property_storage WHERE record_id = $1`,
    [input.propertyId],
  );
  const outcomeChanged = prior ? prior.had_error === input.ok : true;

  const claimed = await db.query(
    `UPDATE ipy_property_storage
        SET media_done_at = now(),
            last_error = $2,
            updated_at = now()
      WHERE record_id = $1
      RETURNING record_id`,
    [input.propertyId, input.ok ? null : (input.summary ?? 'processing failed')],
  );

  if (claimed.rowCount > 0 && prior?.already && !outcomeChanged) {
    logger.info(
      { propertyId: input.propertyId, ok: input.ok },
      'n8n reported the same outcome again; not notifying',
    );
    res.json({ ok: true, notified: 0, duplicate: true });
    return;
  }

  // The owner. Shoot sessions are gone, so there is no second person to find:
  // whoever uploaded did it in OneDrive, which the CRM never saw.
  const recipients: string[] = [];
  if (property.owner_id) recipients.push(property.owner_id);
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
