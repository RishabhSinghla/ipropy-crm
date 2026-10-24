/**
 * A small pretend OpenWA, for tests.
 *
 * It speaks only the handful of routes the CRM uses, from OpenWA's own API
 * specification, and it records everything it is asked to do — so a test can
 * prove what the CRM *would* have sent without a real phone or a real
 * WhatsApp message anywhere. Nothing here talks to the internet.
 *
 * It can also play the other direction: `deliver()` posts a signed webhook to
 * the CRM exactly as OpenWA would (HMAC-SHA256 over the raw body, in
 * `X-OpenWA-Signature`), which is how the e2e spec makes "a customer wrote".
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSend {
  /** The short message id OpenWA would announce this message under in webhooks. */
  id: string;
  route: string;
  chatId: string;
  text?: string;
  caption?: string;
  filename?: string;
  bytes?: number;
  idempotencyKey: string | null;
}

export interface FakeOpenWa {
  baseUrl: string;
  apiKey: string;
  sessionName: string;
  sessionId: string;
  sends: FakeSend[];
  /** ready | qr_ready | disconnected … — whatever the session should claim. */
  status: string;
  phone: string;
  /** When set, sends answer 429 SEND_PACING_LIMITED with this wait. */
  pacingRetryAfter: number | null;
  /** Files served from the media route, by message id. */
  media: Map<string, { mimeType: string; data: Buffer }>;
  requests: { method: string; url: string }[];
  close(): Promise<void>;
  /** Post a signed webhook to the CRM, the way OpenWA does. */
  deliver(url: string, secret: string, event: string, data: Record<string, unknown>, opts?: {
    timestamp?: string; signatureSecret?: string; unsigned?: boolean;
  }): Promise<Response>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startFakeOpenWa(options: { port?: number; sessionName?: string; apiKey?: string } = {}): Promise<FakeOpenWa> {
  const fake: FakeOpenWa = {
    baseUrl: '',
    apiKey: options.apiKey ?? 'fake-openwa-api-key',
    sessionName: options.sessionName ?? 'company',
    sessionId: 'fake-session-id',
    sends: [],
    status: 'ready',
    phone: '919800000001',
    pacingRetryAfter: null,
    media: new Map(),
    requests: [],
    close: async () => undefined,
    deliver: async () => { throw new Error('not started'); },
  };
  let counter = 0;
  // Unique per fake, so ids from one run never collide with the CRM's memory of an earlier run's.
  const run = Math.random().toString(36).slice(2, 7).toUpperCase();

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    fake.requests.push({ method: req.method ?? 'GET', url: url.pathname + url.search });

    if (url.pathname === '/api/health') { json(res, 200, { status: 'ok' }); return; }
    if (req.headers['x-api-key'] !== fake.apiKey) { json(res, 401, { statusCode: 401, message: 'Invalid API key' }); return; }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const wanted = url.searchParams.get('name');
      const rows = !wanted || wanted === fake.sessionName
        ? [{
          id: fake.sessionId, name: fake.sessionName, status: fake.status, phone: fake.phone,
          pushName: 'Company', restriction: null, lastError: null, engineLoaded: true,
        }]
        : [];
      json(res, 200, rows);
      return;
    }

    const send = /^\/api\/sessions\/([^/]+)\/messages\/(send-text|send-image|send-video|send-audio|send-document)$/.exec(url.pathname);
    if (req.method === 'POST' && send) {
      if (send[1] !== fake.sessionId) { json(res, 404, { statusCode: 404, message: `Session '${send[1]}' not found` }); return; }
      if (fake.status !== 'ready') { json(res, 400, { statusCode: 400, message: 'Session is not active' }); return; }
      if (fake.pacingRetryAfter !== null) {
        json(res, 429, { statusCode: 429, code: 'SEND_PACING_LIMITED', message: 'paced', retryAfterSeconds: fake.pacingRetryAfter });
        return;
      }
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      counter += 1;
      const id = `FAKE${run}${counter}`;
      fake.sends.push({
        id,
        route: send[2]!,
        chatId: String(body.chatId),
        text: typeof body.text === 'string' ? body.text : undefined,
        caption: typeof body.caption === 'string' ? body.caption : undefined,
        filename: typeof body.filename === 'string' ? body.filename : undefined,
        bytes: typeof body.base64 === 'string' ? Buffer.from(body.base64, 'base64').byteLength : undefined,
        idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
      });
      json(res, 201, { messageId: `true_${body.chatId}_${id}`, timestamp: Math.floor(Date.now() / 1000) });
      return;
    }

    const media = /^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/([^/]+)\/media$/.exec(url.pathname);
    if (req.method === 'GET' && media) {
      const file = fake.media.get(decodeURIComponent(media[3]!));
      if (!file) { json(res, 404, { statusCode: 404, message: 'No media stored for this message' }); return; }
      res.writeHead(200, { 'content-type': file.mimeType, 'content-length': file.data.byteLength });
      res.end(file.data);
      return;
    }

    json(res, 404, { statusCode: 404, message: 'not in the fake' });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  fake.deliver = async (url, secret, event, data, opts = {}) => {
    const body = JSON.stringify({
      event,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      sessionId: fake.sessionName,
      idempotencyKey: `msg_${fake.sessionName}_${String(data.id ?? data.messageId ?? Math.random())}`,
      deliveryId: `dlv_${Math.random().toString(36).slice(2)}`,
      data,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-openwa-event': event };
    if (!opts.unsigned) {
      headers['x-openwa-signature'] = `sha256=${createHmac('sha256', opts.signatureSecret ?? secret).update(body).digest('hex')}`;
    }
    return fetch(url, { method: 'POST', headers, body });
  };
  return fake;
}

/** An inbound message in the shape OpenWA's `message.received` carries. */
export function inboundMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { phone: phoneOverride, ...rest } = overrides;
  const phone = String(phoneOverride ?? '919811111111');
  return {
    id: `3EB0${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
    from: `${phone}@c.us`, to: '919800000001@c.us', chatId: `${phone}@c.us`,
    body: 'Is the flat still available?', type: 'chat',
    timestamp: Math.floor(Date.now() / 1000), isGroup: false, kind: 'individual', fromMe: false,
    contact: { pushName: 'Test Customer' },
    ...rest,
  };
}
