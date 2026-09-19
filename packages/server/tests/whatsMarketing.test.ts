/**
 * The WhatsMarketing adapter, against their own documented shapes.
 *
 * This adapter replaced a guess. The guess — that they proxy Meta's Cloud API,
 * which most resellers of their size do — was wrong in four ways, and one of
 * those four could not have been caught by reading the code or by a typecheck:
 *
 *   **A refused message answers HTTP 200.** Their API puts success in a JSON
 *   field, `{"status":"1"}`, and a refusal is `{"status":"0"}` with the reason
 *   in `message` — also 200. Any adapter that trusts `res.ok` records every
 *   refused send as sent, the conversation shows a tick, and the customer got
 *   nothing. That is the single most expensive thing in this file and it is
 *   the first test below.
 *
 * `fetch` is stubbed rather than called: the point is what this code sends and
 * how it reads an answer, and proving that must not depend on a vendor being
 * up, on a real API token, or on messaging a real person to watch it work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credentials = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const config = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock('../src/core/settings/integrations.js', () => ({
  getIntegrationCredentials: () => credentials.value,
  getIntegrationConfig: () => config.value,
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { parseWhatsMarketingWebhook, whatsMarketingProvider } =
  await import('../src/integrations/whatsapp/business/whatsMarketing.js');

/** The calls the adapter made, so the form body can be read back. */
let sent: { url: string; body: string }[] = [];

const answerWith = (payload: unknown, status = 200): void => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? '') });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
      headers: new Map(),
    } as unknown as Response;
  }));
};

const form = (i = 0): URLSearchParams => new URLSearchParams(sent[i].body);

beforeEach(() => {
  sent = [];
  credentials.value = { apiToken: 'tok_abc', webhookToken: 'hook_secret_1234' };
  config.value = { phoneNumberId: '337228512808270', businessNumber: '919876543210' };
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('sending', () => {
  it('treats status "0" as a refusal even though the HTTP call succeeded', async () => {
    /*
      The whole reason this file exists. 200 OK, and the message did not go.
    */
    answerWith({ status: '0', message: 'Subscriber limit has been exceeded.' });
    await expect(whatsMarketingProvider.sendMessage({ accountId: null, to: '919876543210', text: 'hi' }))
      .rejects.toThrow(/Subscriber limit/);
  });

  it('sends text as a form post with the token in the body', async () => {
    answerWith({ status: '1', wa_message_id: 'wamid.ABC', message: 'Message sent successfully.' });
    const out = await whatsMarketingProvider.sendMessage({
      accountId: null, to: '+91 98765 43210', text: 'Hello from iPropy',
    });

    expect(sent[0].url).toBe('https://app.whatsmarketing.in/api/v1/whatsapp/send');
    expect(form().get('apiToken')).toBe('tok_abc');
    expect(form().get('phone_number_id')).toBe('337228512808270');
    // Digits only with the country code, which is what their docs require.
    expect(form().get('phone_number')).toBe('919876543210');
    expect(form().get('message')).toBe('Hello from iPropy');
    expect(out.providerMessageId).toBe('wamid.ABC');
    // `queued`, not `sent`: their API has only accepted it at this point, and
    // a tick the customer's phone has not earned is a lie on the screen.
    expect(out.status).toBe('queued');
  });

  it('refuses to report a send when no message id came back', async () => {
    answerWith({ status: '1', message: 'ok' });
    await expect(whatsMarketingProvider.sendMessage({ accountId: null, to: '919876543210', text: 'hi' }))
      .rejects.toThrow(/returned no id/);
  });

  it('says what to fill in when nothing is configured, rather than failing obscurely', async () => {
    credentials.value = {};
    config.value = {};
    await expect(whatsMarketingProvider.sendMessage({ accountId: null, to: '919876543210', text: 'hi' }))
      .rejects.toThrow(/Admin → Integrations/);
    expect(await whatsMarketingProvider.isConfigured()).toBe(false);
  });

  it('sends a document with the media_name their API requires', async () => {
    /*
      Their console states `media_name` is required when the type is document.
      Without it the send is refused outright — and an earlier version of this
      adapter smuggled the filename into the caption instead, which was both a
      refused message and an untitled PDF for the customer.
    */
    answerWith({ status: '1', wa_message_id: 'wamid.FILE' });
    await whatsMarketingProvider.sendMedia({
      accountId: null, to: '919876543210', type: 'document',
      link: 'https://crm.ipropy.com/api/public/whatsapp-media/abc?e=1&s=2',
      filename: 'Brochure B-110.pdf',
    });
    expect(form().get('media_url')).toContain('/api/public/whatsapp-media/abc');
    expect(form().get('media_type')).toBe('document');
    expect(form().get('media_name')).toBe('Brochure B-110.pdf');
  });

  it('never sends a document with an empty media_name, which they refuse', async () => {
    answerWith({ status: '1', wa_message_id: 'wamid.F2' });
    await whatsMarketingProvider.sendMedia({
      accountId: null, to: '919876543210', type: 'document', link: 'https://x/y',
    });
    expect(form().get('media_name')).toBeTruthy();
  });

  it('never captions audio, which their API does not support', async () => {
    answerWith({ status: '1', wa_message_id: 'wamid.AUD' });
    await whatsMarketingProvider.sendMedia({
      accountId: null, to: '919876543210', type: 'audio',
      link: 'https://example.com/note.mp3', caption: 'voice note',
    });
    expect(form().has('media_caption_text')).toBe(false);
  });
});

describe('templates', () => {
  it('turns a template name into their numeric id before sending', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? '') });
      const payload = String(url).includes('/get/template/list')
        ? { status: '1', message: [{ id: 48, template_id: '404470', template_name: 'site_visit_reminder', body_content: 'Hi {{1}}, visit on {{2}}' }] }
        : { status: '1', wa_message_id: 'wamid.TPL' };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as unknown as Response;
    }));

    await whatsMarketingProvider.sendTemplate({
      to: '919876543210', templateName: 'site_visit_reminder', language: 'en',
      params: ['Rishabh', '20 Sep'],
    });

    const body = form(1);
    expect(sent[1].url).toContain('/whatsapp/send/template');
    expect(body.get('template_id')).toBe('404470');
    // Their variables are positional with a name attached. The position is the
    // half that has to be right, and it is the half this pins.
    expect(body.get('templateVariable-var-1')).toBe('Rishabh');
    expect(body.get('templateVariable-var-2')).toBe('20 Sep');
  });

  it('names the template it could not find instead of posting a blank id', async () => {
    answerWith({ status: '1', message: [] });
    await expect(whatsMarketingProvider.sendTemplate({
      to: '919876543210', templateName: 'no_such_template', language: 'en', params: [],
    })).rejects.toThrow(/no template called "no_such_template"/);
  });

  it('counts the blanks in a template body so a mapping cannot under-fill it', async () => {
    answerWith({ status: '1', message: [{ template_id: '9', template_name: 'x', body_content: '{{1}} and {{2}} and {{3}}' }] });
    const rows = await whatsMarketingProvider.listTemplates();
    expect(rows[0].variableCount).toBe(3);
    expect(rows[0].providerTemplateId).toBe('9');
  });

  it('believes their own variable_map over counting placeholders', async () => {
    // `variable_map` is what they publish and what Meta approved. A body whose
    // text has been edited since is the case where the two disagree.
    answerWith({ status: '1', message: [{
      template_id: '9', template_name: 'x', body_content: 'Hi {{1}}',
      variable_map: { header: [], body: ['name', 'date'] },
    }] });
    expect((await whatsMarketingProvider.listTemplates())[0].variableCount).toBe(2);
  });

  it('reads a single template, which they return as an object rather than a list', async () => {
    /*
      Their `message` key is an object when there is one row and an array when
      there are several. An account with exactly one approved template would
      otherwise show none at all — and "none" reads as the sync being broken.
    */
    answerWith({ status: '1', message: { template_id: '77', template_name: 'only_one', body_content: 'hi' } });
    const rows = await whatsMarketingProvider.listTemplates();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('only_one');
  });
});

describe('the webhook door', () => {
  it('refuses a delivery when no token is configured, rather than waving it through', () => {
    credentials.value = { apiToken: 'tok_abc' };
    const answer = whatsMarketingProvider.verifyWebhook({
      method: 'POST', query: {}, headers: {}, rawBody: '{}',
    });
    expect(answer.ok).toBe(false);
    expect(answer.reason).toBe('no-webhook-token');
  });

  it('accepts the right token and refuses a wrong one of the same length', () => {
    const ok = whatsMarketingProvider.verifyWebhook({
      method: 'POST', query: {}, headers: { 'x-webhook-token': 'hook_secret_1234' }, rawBody: '{}',
    });
    expect(ok.ok).toBe(true);

    const bad = whatsMarketingProvider.verifyWebhook({
      method: 'POST', query: { token: 'hook_secret_9999' }, headers: {}, rawBody: '{}',
    });
    expect(bad.ok).toBe(false);
  });
});

describe('reading what comes back', () => {
  it('reads an inbound message in their own vocabulary', () => {
    const batch = parseWhatsMarketingWebhook({
      wa_message_id: 'wamid.IN', phone_number: '919876543210',
      message: 'Is the 3 BHK still available?', name: 'Anita',
      timestamp: '2026-09-19 14:30:00',
    });
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0].from).toBe('919876543210');
    expect(batch.messages[0].text).toBe('Is the 3 BHK still available?');
    expect(batch.messages[0].profileName).toBe('Anita');
    expect(batch.messages[0].sentAt.toISOString()).toBe('2026-09-19T14:30:00.000Z');
  });

  it('reads a delivery update as a status, not as a message from the customer', () => {
    const batch = parseWhatsMarketingWebhook({
      wa_message_id: 'wamid.OUT', message_status: 'delivered',
      delivery_status_updated_at: '2026-07-08 13:21:03',
    });
    expect(batch.messages).toHaveLength(0);
    expect(batch.statuses[0]).toMatchObject({ providerMessageId: 'wamid.OUT', state: 'delivered' });
  });

  it('keeps a picture as a link to collect, not as text', () => {
    const batch = parseWhatsMarketingWebhook({
      wa_message_id: 'wamid.IMG', phone_number: '919876543210',
      media_url: 'https://cdn.whatsmarketing.in/x.jpg', media_type: 'image',
      media_caption_text: 'the balcony',
    });
    expect(batch.messages[0].type).toBe('image');
    expect(batch.messages[0].media?.link).toBe('https://cdn.whatsmarketing.in/x.jpg');
  });

  it('returns nothing for a shape it does not know, and does not invent a message', () => {
    /*
      Their documentation has no inbound webhook section at all. So the honest
      failure is an empty batch plus a logged body somebody can read — never a
      half-parsed message attributed to a number that was guessed at.
    */
    const batch = parseWhatsMarketingWebhook({ something: 'entirely else' });
    expect(batch.messages).toHaveLength(0);
    expect(batch.statuses).toHaveLength(0);
  });

  it('leaves Meta-shaped deliveries to the Meta adapter', () => {
    const batch = parseWhatsMarketingWebhook({ object: 'whatsapp_business_account', entry: [] });
    expect(batch.messages).toHaveLength(0);
  });
});

describe('delivery ticks', () => {
  it('asks with the message id alone, as their console does', async () => {
    /*
      The PDF asked for a `whatsapp_bot_id` too, and requiring one meant every
      tick read "unknown" for anybody who had not hunted down an id their own
      console never asks for.
    */
    answerWith({ status: '1', message: { message_status: 'delivered' } });
    expect(await whatsMarketingProvider.getMessageStatus('wamid.X')).toBe('delivered');
    expect(form().get('wa_message_id')).toBe('wamid.X');
    expect(form().has('whatsapp_bot_id')).toBe(false);
  });

  it('says unknown rather than failing a whole conversation over a tick', async () => {
    answerWith({ status: '0', message: 'nope' });
    expect(await whatsMarketingProvider.getMessageStatus('wamid.X')).toBe('unknown');
  });
});

describe('the Test button', () => {
  it('uses their documented credential check and reports what it got', async () => {
    answerWith({ status: '1', message: 'ok' });
    const answer = await whatsMarketingProvider.testConnection();
    expect(sent[0].url).toContain('/user/myInfo?apiToken=tok_abc');
    expect(answer.ok).toBe(true);
  });

  it('checks the token on its own and says which half is still missing', async () => {
    /*
      Their key and their Phone Number ID are on two different pages of their
      dashboard, so somebody will paste one and press Test. "Add both first"
      tells them nothing about the half they have already done right.
    */
    config.value = {};
    answerWith({ status: '1', message: [] });
    const answer = await whatsMarketingProvider.testConnection();
    expect(sent[0].url).toContain('/user/package/list');
    expect(answer.detail).toMatch(/token works/i);
    expect(answer.detail).toMatch(/Phone Number ID/);
  });

  it('says a bad token is bad even when the Phone Number ID is missing too', async () => {
    config.value = {};
    answerWith({ status: '0', message: 'Authentication failed' });
    expect((await whatsMarketingProvider.testConnection()).detail).toBe('Authentication failed');
  });

  it('reports their refusal in their own words rather than a status code', async () => {
    answerWith({ status: '0', message: 'Authentication failed' });
    const answer = await whatsMarketingProvider.testConnection();
    expect(answer.ok).toBe(false);
    expect(answer.detail).toBe('Authentication failed');
  });
});
