/**
 * The WhatsApp bridge.
 *
 * Holds one linked WhatsApp session per rep and carries messages between those
 * sessions and the CRM. It is the same mechanism WhatsApp Web uses: the phone
 * stays the account, this is an extra device on it.
 *
 * It runs on the always-on Mac beside the media worker, and for the same
 * reason. A WhatsApp session is long-lived state that has to survive a
 * redeploy, and the CRM runs in a container Render restarts whenever it likes.
 *
 * ## It only ever calls out
 *
 * Every exchange is this process calling the CRM. The CRM never calls back.
 * That means the machine holding the sessions needs no public address, no
 * tunnel, no port forwarding and no inbound firewall rule, which removes the
 * whole question of exposing a laptop to the internet.
 *
 * ## It decides almost nothing
 *
 * Who to message, what to say, and how fast are all the CRM's business. This
 * asks what to do and does it. The pacing in particular is deliberately not
 * here: this process gets restarted, run twice by accident, and edited by
 * whoever is curious, so anything it remembers about how recently it sent
 * something is forgotten at exactly the wrong moment. The CRM hands out one
 * message per number at a time and refuses the next until the gap has passed,
 * which a bridge polling in a tight loop cannot hurry.
 *
 * ## The thing to be careful about
 *
 * WhatsApp does not permit this and can ban the number. What decides whether
 * that happens is behaviour rather than technique: answering people who wrote
 * first, at a human pace, inside waking hours, is tolerated; waking up and
 * firing sixty messages at strangers is not. The limits live in the CRM, in
 * integrations/whatsapp/linkedDevice.ts.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys';
import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CRM_URL = (process.env.CRM_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const TOKEN = process.env.WA_BRIDGE_TOKEN ?? '';
const SESSION_DIR = process.env.WA_SESSION_DIR ?? join(homedir(), '.ipropy-wa-sessions');
/** Only a floor. The CRM tells us how long to wait after each poll. */
const MIN_POLL_SECONDS = Number(process.env.WA_MIN_POLL_SECONDS ?? 5);

if (!TOKEN) {
  console.error('WA_BRIDGE_TOKEN is not set. That token is the only thing standing');
  console.error('between anyone who can reach the CRM and your WhatsApp. Refusing to start.');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

/**
 * Baileys logs its whole protocol handshake at info level, including a JSON
 * dump of the pairing payload. Useful when debugging Baileys itself and pure
 * noise in a log somebody reads to answer "is my WhatsApp connected". Errors
 * still come through, and `WA_DEBUG=1` puts the rest back.
 */
const waLogger = {
  level: process.env.WA_DEBUG ? 'debug' : 'silent',
  trace() {}, debug() {}, info() {},
  warn: (...a) => process.env.WA_DEBUG && log('baileys:', ...a),
  error: (...a) => log('baileys error:', typeof a[0] === 'string' ? a[0] : (a[0]?.message ?? '')),
  fatal: (...a) => log('baileys fatal:', typeof a[0] === 'string' ? a[0] : (a[0]?.message ?? '')),
  child: () => waLogger,
};

// ---------------------------------------------------------------------------
// Talking to the CRM
// ---------------------------------------------------------------------------

async function crm(path, body) {
  const res = await fetch(`${CRM_URL}/api/webhooks/wa-bridge/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-token': TOKEN },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`CRM ${path} answered ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** linkId -> { sock, status, handle, starting } */
const sessions = new Map();

function jidFor(handle) {
  const digits = String(handle).replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

/** The number that scanned, read off whatever shape the socket reports it in. */
function ownNumber(sock) {
  const id = sock?.user?.id ?? '';
  const digits = id.split(':')[0]?.replace(/\D/g, '') ?? '';
  return digits ? `+${digits}` : null;
}

async function startSession(link) {
  if (sessions.get(link.id)?.starting) return;
  sessions.set(link.id, { ...sessions.get(link.id), starting: true });

  const dir = join(SESSION_DIR, link.id);
  await mkdir(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: waLogger,
    // Shows up in the phone's "Linked devices" list. A rep should be able to
    // look at that list and know what this is before deciding to remove it.
    browser: Browsers.appropriate('iPropy CRM'),
    // Marking every incoming chat read from here would clear the unread badges
    // on the rep's own phone, which is their inbox and not ours to tidy.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sessions.set(link.id, { sock, status: 'starting', handle: link.handle, starting: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Drawn here rather than in the browser, so neither the CRM nor the web
      // bundle needs a QR library for one screen.
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      await crm('qr', { linkId: link.id, qr: dataUrl }).catch((e) => log('could not post QR:', e.message));
      log(`link ${link.id.slice(0, 8)}: pairing code sent to the CRM`);
    }

    if (connection === 'open') {
      const handle = ownNumber(sock);
      sessions.set(link.id, { sock, status: 'connected', handle, starting: false });
      await crm('state', { linkId: link.id, status: 'connected', handle: handle ?? '' })
        .catch((e) => log('could not report connected:', e.message));
      log(`link ${link.id.slice(0, 8)}: connected as ${handle}`);
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = status === DisconnectReason.loggedOut;
      sessions.delete(link.id);

      if (loggedOut) {
        // The phone removed this device, so the stored keys are worthless and
        // keeping them means every restart retries a dead session forever.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        await crm('state', {
          linkId: link.id, status: 'logged_out',
          error: 'The phone removed this linked device',
        }).catch(() => {});
        log(`link ${link.id.slice(0, 8)}: logged out from the phone`);
        return;
      }

      // Anything else is an ordinary disconnect. The next poll starts it again,
      // which doubles as the reconnect backoff without a second mechanism.
      // Silent while shutting down, where the close is us and reporting it as a
      // fault trains people to ignore the line that matters.
      if (!stopping) log(`link ${link.id.slice(0, 8)}: disconnected (${status ?? 'no code'}), will retry`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        await forwardInbound(m);
      } catch (err) {
        log('could not forward an inbound message:', err.message);
      }
    }
  });
}

/**
 * Hand a customer's message to the CRM.
 *
 * Skips our own outgoing messages, groups, status broadcasts and anything
 * without a sender. A group is not a lead and filing one against a record would
 * put a dozen strangers' words on somebody's timeline.
 */
async function forwardInbound(m) {
  if (m.key.fromMe) return;
  const jid = m.key.remoteJid ?? '';
  if (!jid.endsWith('@s.whatsapp.net')) return;

  const msg = m.message ?? {};
  const text =
    msg.conversation
    ?? msg.extendedTextMessage?.text
    ?? msg.imageMessage?.caption
    ?? msg.videoMessage?.caption
    ?? msg.buttonsResponseMessage?.selectedDisplayText
    ?? msg.listResponseMessage?.title
    ?? null;

  const media =
    msg.imageMessage ? 'image'
      : msg.videoMessage ? 'video'
        : msg.documentMessage ? 'document'
          : msg.audioMessage ? 'audio'
            : null;

  // Nothing readable and nothing attached: a reaction, a receipt, a protocol
  // message. Filing it would put an empty row on somebody's timeline.
  if (!text && !media) return;

  await crm('inbound', {
    from: `+${jid.split('@')[0]}`,
    providerMessageId: m.key.id,
    type: media ?? 'text',
    ...(text ? { text } : {}),
    ...(media ? { mediaId: m.key.id, mimeType: msg[`${media}Message`]?.mimetype } : {}),
    timestamp: Number(m.messageTimestamp) || undefined,
    profileName: m.pushName || undefined,
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sendOne(job) {
  const session = sessions.get(job.linkId);
  if (session?.status !== 'connected') {
    await crm('result', { sendId: job.sendId, ok: false, error: 'that number is not connected right now' });
    return;
  }

  try {
    // Ask WhatsApp whether the number is even on it. Sending into nothing is
    // one of the patterns that gets a number flagged, and a lead with a
    // mistyped mobile is common enough to be worth one lookup.
    const [check] = await session.sock.onWhatsApp(jidFor(job.handle));
    if (!check?.exists) {
      await crm('result', { sendId: job.sendId, ok: false, error: 'that number is not on WhatsApp' });
      log(`send ${job.sendId.slice(0, 8)}: ${job.handle} is not on WhatsApp`);
      return;
    }

    const sent = await session.sock.sendMessage(check.jid, { text: job.body });
    await crm('result', {
      sendId: job.sendId,
      ok: true,
      ...(sent?.key?.id ? { providerMessageId: sent.key.id } : {}),
    });
    log(`sent to ${job.handle} from ${session.handle ?? job.linkId.slice(0, 8)}`);
  } catch (err) {
    await crm('result', { sendId: job.sendId, ok: false, error: String(err.message ?? err).slice(0, 400) })
      .catch(() => {});
    log(`send to ${job.handle} failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let stopping = false;

async function tick() {
  const answer = await crm('poll');
  const wanted = new Set(answer.links.map((l) => l.id));

  // A link the CRM no longer lists has been removed by somebody. Drop the
  // socket, but leave the stored keys alone: this also fires when the CRM is
  // briefly unreachable, and deleting credentials on a network blip would make
  // every rep scan again.
  for (const [linkId, session] of sessions) {
    if (!wanted.has(linkId)) {
      session.sock?.end?.(undefined);
      sessions.delete(linkId);
      log(`link ${linkId.slice(0, 8)}: removed in the CRM, session closed`);
    }
  }

  for (const link of answer.links) {
    if (!sessions.has(link.id)) await startSession(link);
  }

  for (const job of answer.outbox ?? []) await sendOne(job);

  if (answer.idleReason && answer.outbox?.length === 0) {
    log(`nothing to send: ${answer.idleReason}`);
  }

  return Math.max(MIN_POLL_SECONDS, answer.retryAfterSeconds ?? 20);
}

async function main() {
  log(`iPropy WhatsApp bridge starting`);
  log(`  CRM      ${CRM_URL}`);
  log(`  sessions ${SESSION_DIR}`);
  if (!existsSync(SESSION_DIR)) await mkdir(SESSION_DIR, { recursive: true });

  while (!stopping) {
    let wait = 20;
    try {
      wait = await tick();
    } catch (err) {
      // A CRM that is down, redeploying or asleep is the normal case, not an
      // emergency. Keep the sessions open and try again.
      log('poll failed:', err.message);
      wait = 30;
    }
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down; sessions stay linked and resume on the next start');
    stopping = true;
    for (const s of sessions.values()) s.sock?.end?.(undefined);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('bridge stopped:', err);
  process.exit(1);
});
