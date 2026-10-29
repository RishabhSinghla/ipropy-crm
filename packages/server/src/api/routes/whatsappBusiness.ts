/**
 * The official WhatsApp Business route, as the CRM's own screens see it.
 *
 * Deliberately thin. Admin work — pasting credentials, switching a provider on
 * — goes through the integration card that already exists for every other
 * service, so there is one place in this CRM where a key is entered and one
 * place where it is encrypted. What is here is what the *card* cannot answer:
 * which provider is live, what it can actually do, whether its credentials
 * work, and sending a message.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { registry } from '../../core/metadata/registry.js';
import { matchKey } from '../../integrations/whatsapp/matchContact.js';
import { assertCapability, canAccessRecord } from '../../core/permissions/index.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import {
  activeBusinessProvider, businessProvider, BUSINESS_PROVIDERS,
} from '../../integrations/whatsapp/business/registry.js';
import { sendOnBusinessNumber } from '../../integrations/whatsapp/business/send.js';
import {
  assign, conversationMessages, listConversations, markRead, markUnread,
  noteViewing, othersViewing, readableConversation,
} from '../../integrations/whatsapp/business/inbox.js';
import { recordConsent } from '../../core/consent/index.js';
import { tellWhatsMarketingAboutConsent } from '../../integrations/whatsapp/business/consentSync.js';
import { db } from '../../db/pool.js';
import { emitToUser, pushNotification } from '../../realtime.js';
import {
  listStoredTemplates, organisationName, resolveTemplate, saveMapping, syncTemplates,
} from '../../integrations/whatsapp/business/templates.js';
import { recordService } from '../../core/entity/recordService.js';
import { threadForNumber } from '../../integrations/whatsapp/business/thread.js';
import {
  assertFollowUpDay, contactBehind, sharePropertyOnWhatsApp,
} from '../../integrations/whatsapp/business/share.js';
import { scheduleFollowUp } from '../../core/workflow/followUp.js';
import {
  approveCampaign, campaignRecipients, createCampaign, listCampaigns, previewCampaign,
  setCampaignStatus,
} from '../../integrations/whatsapp/business/campaigns.js';
import { redactAutomated, rolesInUse } from '../../integrations/whatsapp/business/channelRoles.js';
import { whatsAppOverview } from '../../integrations/whatsapp/business/overview.js';
import {
  enableAllGroups, historyJobStatus, historySupported, listWaGroups, refreshGroupList, setGroupEnabled, startHistoryImport,
} from '../../core/market/liveGroups.js';
import { lookupNumber, recordsWithNumber, saveLookupToRecord } from '../../integrations/whatsapp/business/lookup.js';
import { numberCheckStatus, startNumberCheck, stopNumberCheck } from '../../integrations/whatsapp/business/numberCheck.js';
import { currentLinkHealth, checkOpenWaNow, openWaMetrics } from '../../integrations/whatsapp/business/openwaHealth.js';
import { createLeadFromChat, loadMessageFile } from '../../integrations/whatsapp/business/openwaChats.js';
import { applyFileSecurityHeaders } from '../../core/media/serving.js';

/**
 * May this person send that file to a customer?
 *
 * The file is the CRM's, so the CRM's own rules decide. A file attached to a
 * record is readable by whoever may read the record — which is what stops a
 * rep forwarding a document off a lead they cannot see. A file attached to
 * nothing (an inbound photo from a number nobody has claimed yet) is decided
 * by the conversation, and that is already gated by `whatsapp.send`.
 */
async function assertMaySendFile(req: Parameters<typeof getScope>[0], attachmentId: string): Promise<void> {
  const file = await db.queryOne<{ record_id: string | null }>(
    `SELECT record_id FROM ipy_attachment WHERE id = $1`, [attachmentId],
  );
  if (!file) throw new NotFoundError('That file is no longer here.');
  if (!file.record_id) return;
  const record = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1`, [file.record_id],
  );
  if (!record) return;
  if (!(await canAccessRecord(getScope(req), record.module_name, file.record_id, 'view'))) {
    throw new ForbiddenError('You cannot send a file from a record you cannot open.');
  }
}

/**
 * On a linked device a message goes only to a number tied to something the
 * sender may open: a record they can view that actually holds that number, or
 * an existing chat that is in their inbox. A typed-in stranger is refused —
 * that is the cold-outreach pattern this connection must never be.
 *
 * The official providers keep their old behaviour; this only bites for OpenWA.
 */
async function assertMayMessageOnLinkedDevice(
  req: Parameters<typeof getScope>[0], input: { to: string; recordId?: string },
): Promise<void> {
  const provider = activeBusinessProvider();
  if (!provider?.capabilities.has('linkedDevice')) return;
  const user = getUser(req);
  const key = matchKey(input.to);
  if (!key) throw new BadRequestError('That is not a number WhatsApp can reach.');

  if (input.recordId) {
    const row = await db.queryOne<{ module_name: string }>(
      `SELECT module_name FROM ipy_record WHERE id = $1`, [input.recordId],
    );
    if (!row) throw new NotFoundError('That record no longer exists.');
    // `getRecord` is the permission check: it throws if this person may not open it.
    const record = await recordService.getRecord(getScope(req), row.module_name, input.recordId);
    const handles = await handlesOf(row.module_name, record.values ?? {});
    if (!handles.includes(key)) {
      throw new ForbiddenError('That number is not on this contact, so the CRM will not message it from here.');
    }
    return;
  }

  const convo = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_conversation
      WHERE channel = 'whatsapp' AND handle = $1 AND wa_account_id IS NULL LIMIT 1`,
    [key],
  );
  if (!convo) throw new ForbiddenError('Open the contact first — the CRM only messages numbers it has a record or a chat for.');
  await readableConversation(user.id, user.isAdmin, convo.id);
}

export const whatsappBusinessRouter = Router();
whatsappBusinessRouter.use(requireAuth, blockApiKey);

/*
  The official API runs in the background, for admins to watch and control.
  Once channel roles are set, its templates, template tools and campaigns are
  refused to everyone else here on the server, whatever the screen shows.
  Staff still see the automatic-message toast and the history line, and every
  customer reply, none of which pass through these paths.
*/
whatsappBusinessRouter.use(
  ['/templates', '/send-template', '/campaigns', '/overview', '/providers'],
  (req, _res, next) => {
    if (rolesInUse() && !getUser(req).isAdmin) {
      // The composer asks for the template list on every open; an empty list is
      // the honest answer for somebody who may not use templates, not an error.
      // `req.path` is relative to the mount point here, so rebuild the whole address.
      const address = `${req.baseUrl}${req.path}`.replace(/^.*\/whatsapp-business/, '').replace(/\/$/, '');
      if (req.method === 'GET' && (address === '/templates' || address === '/templates/saved')) {
        _res.json([]);
        return;
      }
      next(new ForbiddenError('The official WhatsApp API is managed by admins only.'));
      return;
    }
    next();
  },
);

/**
 * What the CRM can do on WhatsApp right now.
 *
 * Every screen asks this before offering a control: a provider that cannot
 * send free text (AiSensy's campaign API is templates only) should show the
 * template picker rather than a message box that fails on send.
 */
/**
 * What the number did — the last item on the owner's list for this route.
 *
 * Counted from the CRM's own rows, never the vendor's dashboard, and under the
 * inbox's own visibility rule so a rep cannot read off how many conversations
 * their colleagues are having.
 */
whatsappBusinessRouter.get('/report', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const days = Number(req.query.days ?? 30);
  const { messagingReport } = await import('../../integrations/whatsapp/business/report.js');
  res.json(await messagingReport({
    userId: user.id,
    isAdmin: user.isAdmin,
    days: Number.isFinite(days) ? days : 30,
  }));
}));

whatsappBusinessRouter.get('/status', asyncHandler(async (_req, res) => {
  const provider = activeBusinessProvider();
  if (!provider) {
    res.json({ connected: false, provider: null, capabilities: [], businessNumber: null, split: rolesInUse() });
    return;
  }
  const linked = provider.capabilities.has('linkedDevice');
  res.json({
    connected: await provider.isConfigured(),
    provider: provider.name,
    // True once an admin has given the two routes their jobs: admins then get
    // two WhatsApp screens and everybody else keeps the one.
    split: rolesInUse(),
    capabilities: [...provider.capabilities],
    // Never a network call here: this is asked by every chat screen. The
    // minute timer (and OpenWA's own session webhooks) keep it fresh.
    businessNumber: linked ? currentLinkHealth().phoneMasked : await provider.businessNumber(),
    link: linked ? currentLinkHealth() : null,
  });
}));

/** OpenWA's health in numbers, for the Health page. `?fresh=1` asks OpenWA right now. */
whatsappBusinessRouter.get('/openwa/health', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  if (req.query.fresh === '1') await checkOpenWaNow();
  res.json(await openWaMetrics());
}));

/**
 * Everything about WhatsApp on one screen, so nobody has to open the vendor's.
 *
 * `admin.integrations`, because it names the provider and what it can do.
 * Reads only rows the CRM owns — no vendor call, so it still answers when
 * WhatsMarketing are having an afternoon, which is exactly when somebody opens
 * it.
 */
whatsappBusinessRouter.get('/overview', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  res.json(await whatsAppOverview());
}));

/** The four adapters and what each is able to do, for the admin panel. */
whatsappBusinessRouter.get('/providers', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.integrations');
  res.json(BUSINESS_PROVIDERS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    capabilities: [...entry.provider.capabilities],
    webhookPath: `/api/webhooks/whatsapp/${entry.id.replace('whatsapp_', '')}`,
  })));
}));

/** Prove the credentials, before anybody relies on them with a customer waiting. */
whatsappBusinessRouter.post('/providers/:id/test', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.integrations');
  const provider = businessProvider(req.params.id);
  if (!provider) throw new NotFoundError('No such WhatsApp provider.');
  res.json(await provider.testConnection());
}));

/** The approved template list, where the provider hands it back. */
whatsappBusinessRouter.get('/templates', asyncHandler(async (_req, res) => {
  const provider = activeBusinessProvider('automation');
  if (!provider) { res.json([]); return; }
  if (!provider.capabilities.has('templateSync')) { res.json([]); return; }
  res.json(await provider.listTemplates());
}));

const sendSchema = z.object({
  to: z.string().min(6).max(24),
  text: z.string().min(1).max(4096).optional(),
  template: z.object({
    name: z.string().min(1).max(120),
    language: z.string().min(2).max(10).default('en'),
    params: z.array(z.string().max(500)).max(20).default([]),
    headerMedia: z.object({ link: z.string().url(), filename: z.string().max(200).optional() }).optional(),
  }).optional(),
  /**
   * A file already in the CRM, by id — never a URL. A caller who could name
   * any link could make the CRM fetch and republish whatever it can reach.
   */
  attachmentId: z.string().uuid().optional(),
  recordId: z.string().uuid().optional(),
}).refine((value) => {
  // A template is its own whole message: its wording is approved and frozen,
  // so a caption or an attachment alongside it has nowhere to go.
  if (value.template) return !value.text && !value.attachmentId;
  // Otherwise: a message, a file, or a file with a caption.
  return Boolean(value.text) || Boolean(value.attachmentId);
}, {
  message: 'Send a message, a file, or an approved template — not a template with either.',
});

whatsappBusinessRouter.post('/send', asyncHandler(async (req, res) => {
  const user = getUser(req);
  // The same capability that already gates every other outbound message in the
  // CRM. A new one would mean re-granting the team something they have.
  await assertCapability(user, 'whatsapp.send');
  const input = sendSchema.parse(req.body ?? {});
  if (input.template && rolesInUse() && !user.isAdmin) {
    throw new ForbiddenError('Templates are sent automatically by the workflow; only admins can send one by hand.');
  }
  if (!activeBusinessProvider(input.template ? 'automation' : 'chat')) throw new BadRequestError('No official WhatsApp provider is switched on.');
  if (input.attachmentId) await assertMaySendFile(req, input.attachmentId);
  await assertMayMessageOnLinkedDevice(req, input);

  res.json(await sendOnBusinessNumber({
    userId: user.id,
    to: input.to,
    text: input.text,
    template: input.template,
    attachmentId: input.attachmentId,
    recordId: input.recordId ?? null,
  }));
}));

// ---------------------------------------------------------------------------
// The shared inbox
// ---------------------------------------------------------------------------

const filters = ['all', 'mine', 'unassigned', 'unread', 'unmatched'] as const;

whatsappBusinessRouter.get('/conversations', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const query = z.object({
    filter: z.enum(filters).default('all'),
    // A module name, checked as an identifier rather than against a list:
    // there are two modules today and an admin may add a third with no deploy.
    module: z.string().regex(/^[a-z_][a-z0-9_]*$/i).max(64).optional(),
    search: z.string().max(120).optional(),
    route: z.enum(['chat', 'api']).optional(),
  }).parse(req.query ?? {});
  res.json(await listConversations({
    route: query.route,
    userId: user.id,
    isAdmin: user.isAdmin,
    filter: query.filter,
    module: query.module,
    search: query.search,
  }));
}));

whatsappBusinessRouter.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const user = getUser(req);
  // Noted before the read, so two reps opening the same customer see each
  // other rather than both typing an answer.
  noteViewing(req.params.id, user.id, user.fullName ?? 'Somebody');
  res.json({
    messages: await conversationMessages(user.id, user.isAdmin, req.params.id, req.query.route === 'api' ? 'api' : req.query.route === 'chat' ? 'chat' : undefined),
    alsoViewing: othersViewing(req.params.id, user.id),
  });
}));

whatsappBusinessRouter.post('/conversations/:id/read', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await markRead(user.id, user.isAdmin, req.params.id);
  res.json({ ok: true });
}));

whatsappBusinessRouter.post('/conversations/:id/unread', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await markUnread(user.id, user.isAdmin, req.params.id);
  res.json({ ok: true });
}));

whatsappBusinessRouter.post('/conversations/:id/assign', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({ to: z.string().uuid().nullable() }).parse(req.body ?? {});
  await assign({ userId: user.id, isAdmin: user.isAdmin, conversationId: req.params.id, to: input.to });
  res.json({ ok: true });
}));

/** Take it myself, which is the one every rep uses and deserves its own door. */
whatsappBusinessRouter.post('/conversations/:id/take', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assign({ userId: user.id, isAdmin: user.isAdmin, conversationId: req.params.id, to: user.id });
  res.json({ ok: true });
}));

/**
 * One-click "create contact from this chat" for a number the CRM does not
 * know. Prefilled with the phone and the person's own WhatsApp name — nothing
 * is looked up anywhere else. If the number is already a contact it links to
 * that one instead of making a second.
 */
whatsappBusinessRouter.post('/conversations/:id/create-lead', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  res.json(await createLeadFromChat(getScope(req), user.id, user.isAdmin, req.params.id));
}));

/** A received file, fetched from OpenWA only now that somebody asked to see it. */
whatsappBusinessRouter.get('/messages/:id/file', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const file = await loadMessageFile(user.id, user.isAdmin, req.params.id);
  applyFileSecurityHeaders(res, file.mimeType, file.fileName, false);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.data);
}));

/**
 * Every number on a record, as the ten-digit key a conversation is filed under.
 *
 * `matchKey` on each phone field, so a mobile stored as `+91 98912 22206`,
 * `9891222206` or `0 9891 222206` all land on the same key the inbound path
 * used. Reads every phone field the module has rather than only `mobile`: a
 * contact reached on their alternate number had that conversation too.
 */
async function handlesOf(moduleName: string, values: Record<string, unknown>): Promise<string[]> {
  const module = await registry.getModule(moduleName);
  const keys = new Set<string>();
  for (const field of module?.fields ?? []) {
    if (field.uitype !== 'phone' || !field.isActive) continue;
    const raw = values[field.name];
    const key = matchKey(typeof raw === 'string' ? raw : null);
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * One contact's WhatsApp, for the tab on the record.
 *
 * Permission comes from the *record*, through the ordinary engine: somebody
 * who can open the lead reads its messages, and somebody who cannot never gets
 * here. That is why a manager can read a thread they are not assigned — the
 * contact is the authority, not the inbox.
 */
whatsappBusinessRouter.get('/contacts/:module/:id/messages', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const record = await recordService.getRecord(scope, req.params.module, req.params.id);

  /*
    **By number as well as by link, and this is the whole fix.**

    A conversation is attached to a record by `matchContact` at the moment a
    message arrives. That is the right moment to *try*, and it is the wrong
    moment to rely on: the contact may not exist yet, two records may share the
    number, or the number may sit in a field the matcher does not read. On
    production, 20 September 2026, a thread from 9811533633 sat unlinked while
    a contact holding that exact number sat beside it — and the tab on that
    contact showed nothing at all, which reads as WhatsApp being broken.

    So the tab asks the question a person would: *is there a conversation with
    one of this contact's numbers?* Linking becomes a tidiness that helps the
    shared inbox, rather than the thing the record's own tab depends on.

    It is still read-only and still safe: `getRecord` above decides who may see
    this record, and the numbers come off the record itself, so nobody can read
    a thread belonging to a contact they cannot open.
  */
  const handles = await handlesOf(req.params.module!, record.values ?? {});

  const { rows } = await db.query(
    `SELECT m.id, m.direction, m.type, m.body, m.media, m.status, m.template_name,
            m.created_at, m.route, m.provider,
            -- Why a send failed, so the screen can say it. Without this the
            -- tab paints a refused message the same green as a delivered one
            -- and writes "sent" under it.
            m.error_message,
            trim(u.first_name || ' ' || u.last_name) AS sent_by_name
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
       LEFT JOIN ipy_user u ON u.id = m.sent_by
      WHERE c.channel = 'whatsapp'
        -- The business number only. A thread with a wa_account_id came from
        -- the removed phone-sync route, which copied reps' own WhatsApp off
        -- their handsets: 1,734 rows on production (Aug 2025 – 18 Sep 2026)
        -- that the business inbox has never held, and which read to the owner
        -- as messages appearing from nowhere. Kept in the table, not shown.
        AND c.wa_account_id IS NULL
        AND (c.record_id = $1 OR ($2::text[] <> '{}' AND c.handle = ANY($2::text[])))
      ORDER BY m.created_at ASC
      LIMIT 500`,
    // Bound as a real array even when empty, and guarded by `<> '{}'` above:
    // rule 8's cousin — every parameter a statement names has to be bound, and
    // an empty list must not quietly match everything.
    [req.params.id, handles],
  );
  // Both routes in one column, because the customer had one conversation even
  // if it reached them two ways. `route` says which, on every line.
  // Whether any of this record's numbers has unsubscribed, so the tab can say
  // so rather than offer a Send that will be refused.
  const optedOut = handles.length > 0 && Boolean(await db.queryOne(
    `SELECT 1 FROM ipy_channel_optout
      WHERE channel = 'whatsapp'
        AND right(regexp_replace(handle, '\\D', '', 'g'), 10) = ANY(
          SELECT right(h, 10) FROM unnest($1::text[]) AS h)
      LIMIT 1`,
    [handles],
  ));
  res.json({ messages: redactAutomated(rows, user.isAdmin), user: user.id, optedOut });
}));

/**
 * Unsubscribe somebody from WhatsApp, or put them back — from the Chats screen.
 *
 * The same list a customer's own STOP writes to, and the same list every send
 * checks. Whoever can open the chat can change it; the trail records who did.
 */
const consentBody = z.object({ subscribed: z.boolean() });

whatsappBusinessRouter.post('/conversations/:id/consent', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { subscribed } = consentBody.parse(req.body ?? {});
  const conversation = await readableConversation(user.id, user.isAdmin, req.params.id!);
  await recordConsent({
    handle: conversation.handle, channel: 'whatsapp',
    action: subscribed ? 'opt_in' : 'opt_out', source: 'manual',
    recordId: conversation.recordId, userId: user.id,
  });
  const notedInWhatsMarketing = await tellWhatsMarketingAboutConsent({
    handle: conversation.handle, subscribed, byWhom: user.fullName ?? 'a team member',
  });
  res.json({ optedOut: !subscribed, notedInWhatsMarketing });
}));

/**
 * The same, from a record's WhatsApp tab. Every phone number on the record,
 * because a customer who says "stop" means stop, whichever of their numbers
 * the next message would have gone to.
 */
whatsappBusinessRouter.post('/contacts/:module/:id/consent', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { subscribed } = consentBody.parse(req.body ?? {});
  const record = await recordService.getRecord(getScope(req), req.params.module!, req.params.id!);
  const handles = await handlesOf(req.params.module!, record.values ?? {});
  if (!handles.length) throw new BadRequestError('This record has no phone number to unsubscribe.');
  let notedInWhatsMarketing = false;
  for (const handle of handles) {
    await recordConsent({
      handle, channel: 'whatsapp', action: subscribed ? 'opt_in' : 'opt_out',
      source: 'manual', recordId: req.params.id, userId: user.id,
    });
    const noted = await tellWhatsMarketingAboutConsent({
      handle, subscribed, byWhom: user.fullName ?? 'a team member',
    });
    notedInWhatsMarketing ||= noted;
  }
  res.json({ optedOut: !subscribed, notedInWhatsMarketing });
}));

/**
 * The thread behind one phone number, for the composer.
 *
 * Read-only: opening the composer must not create a conversation (see
 * `business/thread.ts`). The record is the gate, not the thread — this is
 * reached from a record the caller has open, so `recordService.getRecord`
 * decides who may read the messages, exactly as the contact's WhatsApp tab
 * does. Without a record it answers the window state and nothing to read.
 */
whatsappBusinessRouter.get('/threads/by-number', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const query = z.object({
    to: z.string().min(6).max(24),
    module: z.string().min(1).max(60).optional(),
    recordId: z.string().uuid().optional(),
  }).parse(req.query ?? {});

  const readable = Boolean(query.module && query.recordId);
  if (readable) await recordService.getRecord(scope, query.module!, query.recordId!);

  res.json(await threadForNumber(query.to, readable, getUser(req).isAdmin));
}));

// ---------------------------------------------------------------------------
// Sending a unit, and chasing them about it
// ---------------------------------------------------------------------------

/**
 * Send a property to whoever is in this chat.
 *
 * The browser names a property id and nothing else. Which link gets minted,
 * what the message says and whether this rep may see that unit at all are all
 * decided on the server — a screen that composed the text could send a buyer a
 * link to a floor its user was never shown.
 */
whatsappBusinessRouter.post('/share-property', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    to: z.string().min(6).max(24),
    propertyId: z.string().uuid(),
    contactId: z.string().uuid().nullable().optional(),
    note: z.string().max(500).optional(),
  }).parse(req.body ?? {});

  if (!activeBusinessProvider()) throw new BadRequestError('No official WhatsApp provider is switched on.');

  res.json(await sharePropertyOnWhatsApp({
    ctx: getScope(req),
    userId: user.id,
    to: input.to,
    propertyId: input.propertyId,
    contactId: input.contactId ?? null,
    note: input.note,
  }));
}));

/**
 * Chase them on a date, from the conversation.
 *
 * Straight through to `scheduleFollowUp`, which is the one definition of what
 * that means — the date on the record, the note in the timeline, the
 * notification to whoever owns the lead. The only things decided here are that
 * the thread has a contact behind it and that the caller may edit it: a
 * follow-up writes to the record, so reading it is not enough.
 */
whatsappBusinessRouter.post('/conversations/:id/follow-up', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    on: z.string().min(10).max(10),
    reason: z.string().min(1).max(300).default('Follow up on WhatsApp'),
  }).parse(req.body ?? {});

  assertFollowUpDay(input.on);
  const contact = await contactBehind(req.params.id);
  if (!contact) {
    throw new BadRequestError('Link this number to a contact first — a follow-up is a date on a record.');
  }
  if (!(await canAccessRecord(getScope(req), contact.module, contact.id, 'edit'))) {
    throw new ForbiddenError('You cannot set a follow-up on this contact.');
  }

  await scheduleFollowUp({
    recordId: contact.id,
    module: contact.module,
    on: input.on,
    reason: input.reason,
    authorId: user.id,
  });
  res.json({ ok: true, on: input.on });
}));

// ---------------------------------------------------------------------------
// Approved templates, and what fills their blanks
// ---------------------------------------------------------------------------

/** What the CRM holds, with each template's mapping. Read by the composer too. */
whatsappBusinessRouter.get('/templates/saved', asyncHandler(async (_req, res) => {
  res.json(await listStoredTemplates());
}));

whatsappBusinessRouter.post('/templates/sync', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.templates');
  res.json(await syncTemplates());
}));

whatsappBusinessRouter.put('/templates/:id/mapping', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.templates');
  const input = z.object({
    module: z.string().min(1).max(60).default('leads'),
    map: z.record(z.string().max(200)),
  }).parse(req.body ?? {});
  await saveMapping(req.params.id, input.module, input.map);
  res.json({ ok: true });
}));

/**
 * The template as this customer would read it.
 *
 * Offered before every template send, because a positional template is
 * unreadable in the abstract — `{{1}}, your {{2}} at {{3}}` says nothing about
 * whether the mapping is right, and the customer is the one who finds out.
 */
whatsappBusinessRouter.get('/templates/:id/preview', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const query = z.object({
    module: z.string().min(1).max(60).default('leads'),
    recordId: z.string().uuid(),
  }).parse(req.query ?? {});

  res.json(await resolveTemplate({
    ctx: scope,
    templateId: req.params.id,
    module: query.module,
    recordId: query.recordId,
    agentName: user.fullName ?? '',
    orgName: await organisationName(),
  }));
}));

/**
 * Send an approved template, filled from the record.
 *
 * The blanks are filled *here* rather than by the browser: the parameters are
 * the record's own values, and a screen that posted them back could send a
 * customer a budget its user is not allowed to read. `resolveTemplate` goes
 * through `recordService`, so every permission applies.
 */
whatsappBusinessRouter.post('/send-template', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    templateId: z.string().uuid(),
    module: z.string().min(1).max(60).default('leads'),
    recordId: z.string().uuid(),
    to: z.string().min(6).max(24),
  }).parse(req.body ?? {});

  const resolved = await resolveTemplate({
    ctx: scope,
    templateId: input.templateId,
    module: input.module,
    recordId: input.recordId,
    agentName: user.fullName ?? '',
    orgName: await organisationName(),
  });

  if (resolved.missing.length) {
    // Named, not counted: "message failed" tells a rep nothing they can fix,
    // and this is fixable in ten seconds on the record itself.
    throw new BadRequestError(
      `This template cannot go yet — ${resolved.missing.map((gap) => `{{${gap.slot}}} ${gap.reason}`).join('; ')}.`,
    );
  }

  res.json(await sendOnBusinessNumber({
    userId: user.id,
    to: input.to,
    recordId: input.recordId,
    template: { name: resolved.name, language: resolved.language, params: resolved.params },
  }));
}));

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/*
  Two capabilities, deliberately different ones.

  Building and previewing a campaign is `whatsapp.send` — the same permission
  that already lets somebody message one customer. **Approving one is
  `whatsapp.templates`**, which in this CRM is the administrator's side of
  messaging. Writing a campaign and deciding that it goes to nine hundred
  people are not the same decision, and the second is the one that queued forty
  thousand messages last time.
*/
const audienceSchema = z.object({
  view: z.string().uuid().optional(),
  filter: z.any().optional(),
});

whatsappBusinessRouter.get('/campaigns', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.send');
  res.json(await listCampaigns());
}));

whatsappBusinessRouter.post('/campaigns', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    name: z.string().min(1).max(120),
    module: z.string().min(1),
    templateId: z.string().uuid(),
    audience: audienceSchema,
  }).parse(req.body ?? {});
  res.json(await createCampaign({ ...input, userId: user.id }));
}));

/** Who it would reach and what the first few would read. Writes nothing. */
whatsappBusinessRouter.post('/campaigns/preview', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.send');
  const input = z.object({
    module: z.string().min(1),
    templateId: z.string().uuid(),
    audience: audienceSchema,
  }).parse(req.body ?? {});
  res.json(await previewCampaign({
    ctx: getScope(req),
    module: input.module,
    audience: input.audience,
    templateId: input.templateId,
    agentName: user.fullName ?? '',
  }));
}));

whatsappBusinessRouter.post('/campaigns/:id/approve', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'whatsapp.templates');
  const input = z.object({
    // What the screen showed. A mismatch refuses rather than sending to a
    // number nobody agreed to.
    expectedCount: z.number().int().min(0),
    confirmLarge: z.boolean().optional(),
  }).parse(req.body ?? {});
  res.json(await approveCampaign({
    ctx: getScope(req),
    userId: user.id,
    campaignId: req.params.id!,
    expectedCount: input.expectedCount,
    confirmLarge: input.confirmLarge,
  }));
}));

whatsappBusinessRouter.post('/campaigns/:id/status', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.templates');
  const input = z.object({ status: z.enum(['paused', 'running', 'cancelled']) }).parse(req.body ?? {});
  await setCampaignStatus(req.params.id!, input.status);
  res.json({ ok: true });
}));

/** Who got it, who did not, and why. */
whatsappBusinessRouter.get('/campaigns/:id/recipients', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'whatsapp.send');
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(await campaignRecipients(req.params.id!, status));
}));

// ---------------------------------------------------------------------------
// Dealer groups, read live from the linked number. Administrators only: choosing
// which groups the CRM may read is a privacy decision, and so is reading history.
// ---------------------------------------------------------------------------

async function assertGroupAdmin(req: Parameters<typeof getUser>[0]): Promise<void> {
  const user = getUser(req);
  if (!user.isAdmin) throw new ForbiddenError('Only an administrator can manage group sync.');
  await assertCapability(user, 'admin.integrations');
}

whatsappBusinessRouter.get('/groups', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  res.json({ groups: await listWaGroups(), history: { ...historyJobStatus(), supported: await historySupported() } });
}));

/** Asks OpenWA for the groups the number is in. Switched-off by default; nothing is read from them. */
whatsappBusinessRouter.post('/groups/refresh', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  try {
    res.json(await refreshGroupList());
  } catch (err) {
    throw new BadRequestError((err as Error).message);
  }
}));

whatsappBusinessRouter.post('/groups/enable-all', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  res.json({ enabled: await enableAllGroups() });
}));

whatsappBusinessRouter.put('/groups/:id', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
  try {
    const row = await setGroupEnabled(decodeURIComponent(req.params.id!), enabled);
    if (!row) throw new NotFoundError('That group is not in the list.');
    res.json(row);
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    throw new BadRequestError((err as Error).message);
  }
}));

/** Reads what the switched-on groups said before today, slowly. `groupId` limits it to one group. */
whatsappBusinessRouter.post('/groups/import-history', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  const { groupId } = z.object({ groupId: z.string().max(100).optional() }).parse(req.body ?? {});
  res.json(await startHistoryImport(groupId));
}));

// ---------------------------------------------------------------------------
// The WhatsApp name and photo checker. Administrators only, started by hand, slow on purpose.
// ---------------------------------------------------------------------------

whatsappBusinessRouter.get('/number-check', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  res.json(await numberCheckStatus());
}));

whatsappBusinessRouter.post('/number-check/start', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  const { dailyCap } = z.object({ dailyCap: z.number().int().optional() }).parse(req.body ?? {});
  res.json(startNumberCheck(dailyCap));
}));

whatsappBusinessRouter.post('/number-check/stop', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  stopNumberCheck();
  res.json({ ok: true });
}));

/*
  "Send me a test card": pushes the very same events a real WhatsApp message or a
  ringing phone would, to the administrator who pressed it and nobody else. It
  lets the corner cards be checked any time without a customer writing in.
  A message card uses Rishabh's own thread when one exists for the number given
  (so Reply really works), otherwise a throwaway id.
*/
whatsappBusinessRouter.post('/test-card', blockApiKey, asyncHandler(async (req, res) => {
  await assertGroupAdmin(req);
  const user = getUser(req);
  const kind = z.object({ kind: z.enum(['whatsapp', 'call']), number: z.string().max(20).optional() }).parse(req.body ?? {});
  const number = (kind.number ?? '').replace(/\D/g, '').slice(-10) || '9891222206';
  if (kind.kind === 'call') {
    const base = { number, direction: 'incoming', speaker: false, muted: false, connectedSecondsAgo: null, updatedSecondsAgo: 0, canControlCall: false, canEndCall: false };
    emitToUser(user.id, 'phone:call', { ...base, state: 'ringing', talkedSeconds: null });
    // Unanswered after a while becomes "Missed call", like a real one.
    setTimeout(() => emitToUser(user.id, 'phone:call', { ...base, state: 'ended', talkedSeconds: 0 }), 15_000);
    res.json({ sent: true });
    return;
  }
  const convo = await db.queryOne<{ id: string; record_id: string | null; contact_name: string | null }>(
    `SELECT id, record_id, contact_name FROM ipy_conversation WHERE handle = $1 AND channel = 'whatsapp' ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [number],
  );
  pushNotification(user.id, {
    id: `test-${Date.now()}`, kind: 'whatsapp', title: 'WhatsApp from test', body: 'This is a test card. Try Reply, Open chat or Dismiss.',
    link: null, recordId: convo?.record_id ?? null, conversationId: convo?.id ?? `test-${Date.now()}`, handle: number,
    contactName: convo?.contact_name ?? 'Test contact', module: 'leads',
  });
  res.json({ sent: true, realThread: Boolean(convo) });
}));

// ---------------------------------------------------------------------------
// WhatsApp Lookup: who is this number on WhatsApp. Everybody signed in may use it, one number at a time;
// the limits live in `lookup.ts`. Saving to a record is the person's own edit permission, not an admin one.
// ---------------------------------------------------------------------------

whatsappBusinessRouter.post('/lookup', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { number } = z.object({ number: z.string().min(1).max(40) }).parse(req.body ?? {});
  const outcome = await lookupNumber(user.id, number);
  // Which of the CRM's contacts hold it — only ones this person may open.
  const matches = outcome.number ? await recordsWithNumber(getScope(req), outcome.number) : [];
  res.json({ ...outcome, matches });
}));

whatsappBusinessRouter.post('/lookup/save', asyncHandler(async (req, res) => {
  const { number, recordId } = z.object({ number: z.string().min(1).max(40), recordId: z.string().uuid() }).parse(req.body ?? {});
  const digits = number.replace(/\D/g, '');
  try {
    res.json(await saveLookupToRecord(getScope(req), digits, recordId));
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof NotFoundError) throw err;
    throw new BadRequestError((err as Error).message);
  }
}));

/** Who looked up what, for administrators. */
whatsappBusinessRouter.get('/lookup/log', asyncHandler(async (req, res) => {
  if (!getUser(req).isAdmin) throw new ForbiddenError('Only an administrator can read the lookup log.');
  const { rows } = await db.query(
    `SELECT l.created_at, l.number, l.result, l.push_name, l.from_cache,
            trim(u.first_name || ' ' || u.last_name) AS user_name
       FROM ipy_wa_lookup_log l LEFT JOIN ipy_user u ON u.id = l.user_id
      ORDER BY l.created_at DESC LIMIT 100`,
  );
  res.json({ rows });
}));
