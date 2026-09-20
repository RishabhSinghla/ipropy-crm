/**
 * Pulling WhatsMarketing's replies in, since they do not push them.
 *
 * Two of the cases below are the ones that would go wrong quietly, which is
 * the only reason this file is worth its length:
 *
 *  * **Direction.** Their conversation endpoint returns the whole thread, ours
 *    and theirs. Replaying our own outbound messages back through
 *    `receiveInbound` would file them as things the customer said, reopen the
 *    24-hour window on our own message, and notify an agent about their own
 *    reply. Nothing would error; the CRM would simply be wrong about who said
 *    what.
 *
 *  * **The watermark.** It moves to when the visit *started*, not to now. A
 *    reply that lands while the poll is running would otherwise fall in the
 *    gap between the two and never be looked at again — and the only symptom
 *    is one customer's message that never appeared, months later, with nothing
 *    logged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credentials = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const config = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const active = vi.hoisted(() => ({ name: 'whatsapp_whatsmarketing' as string | null }));
const received = vi.hoisted(() => ({ calls: [] as { provider: string; message: Record<string, unknown> }[] }));

const reported = vi.hoisted(() => ({ calls: [] as { ok: boolean; detail: string }[] }));

vi.mock('../src/core/settings/integrations.js', () => ({
  getIntegrationCredentials: () => credentials.value,
  getIntegrationConfig: () => config.value,
  recordIntegrationResult: vi.fn(async (_p: string, ok: boolean, detail: string) => {
    reported.calls.push({ ok, detail });
  }),
}));
vi.mock('../src/db/pool.js', () => ({ db: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/integrations/whatsapp/business/registry.js', () => ({
  activeBusinessProvider: () => (active.name ? { name: active.name } : null),
}));
vi.mock('../src/integrations/whatsapp/business/inbound.js', () => ({
  receiveInbound: vi.fn(async (provider: string, message: Record<string, unknown>) => {
    received.calls.push({ provider, message });
    return { id: 'stored' };
  }),
}));

const { pollWhatsMarketingInbound, textOfMessage, __resetPollWatermark } =
  await import('../src/integrations/whatsapp/business/pollInbound.js');

/** A fixed "now" so the watermark arithmetic is readable. */
const T = (iso: string): string => iso;
const RECENT = T('2026-09-19 12:30:00');
const OLD = T('2026-09-01 09:00:00');

const wire = (subscribers: unknown, thread: unknown): void => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const payload = String(url).includes('/subscriber/list')
      ? { status: '1', message: subscribers }
      : { status: '1', message: thread };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as unknown as Response;
  }));
};

const customerSaid = (text: string, at: string, id = 'wamid.IN1'): Record<string, unknown> => ({
  sender: 'subscriber',
  wa_message_id: id,
  conversation_time: at,
  message_content: JSON.stringify({ type: 'text', text: { body: text } }),
});

beforeEach(() => {
  received.calls = [];
  reported.calls = [];
  active.name = 'whatsapp_whatsmarketing';
  credentials.value = { apiToken: 'tok' };
  config.value = { phoneNumberId: '984702481401419' };
  __resetPollWatermark(new Date('2026-09-10T00:00:00Z'));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('pulling replies in', () => {
  it('stores what the customer wrote, through the same door the webhook uses', async () => {
    wire(
      [{ chat_id: '919811533633', first_name: 'Yogesh', last_name: 'Bindal' }],
      [customerSaid('hey', RECENT)],
    );

    const out = await pollWhatsMarketingInbound();
    expect(out.stored).toBe(1);
    expect(received.calls).toHaveLength(1);

    const [{ provider, message }] = received.calls;
    expect(provider).toBe('whatsapp_whatsmarketing');
    expect(message.from).toBe('919811533633');
    expect(message.text).toBe('hey');
    expect(message.profileName).toBe('Yogesh Bindal');
    expect(message.providerMessageId).toBe('wamid.IN1');
  });

  it('never replays our own outbound as something the customer said', async () => {
    /*
      The quiet one. Their thread carries both directions; treating ours as
      inbound would reopen the 24-hour window on our own message and tell an
      agent they had a reply from themselves.
    */
    wire(
      [{ chat_id: '919811533633' }],
      [
        { sender: 'bot', wa_message_id: 'wamid.OUT', conversation_time: RECENT,
          message_content: JSON.stringify({ text: { body: 'we sent this' } }) },
        { sender: 'agent', wa_message_id: 'wamid.OUT2', conversation_time: RECENT,
          message_content: JSON.stringify({ text: { body: 'and this' } }) },
        customerSaid('but this is theirs', RECENT),
      ],
    );

    await pollWhatsMarketingInbound();
    expect(received.calls).toHaveLength(1);
    expect(received.calls[0].message.text).toBe('but this is theirs');
  });

  it('leaves alone what it has already seen', async () => {
    wire([{ chat_id: '919811533633' }], [customerSaid('ancient', OLD)]);
    expect((await pollWhatsMarketingInbound()).stored).toBe(0);
    expect(received.calls).toHaveLength(0);
  });

  it('moves its watermark to when the visit started, not to now', async () => {
    /*
      A reply that arrives mid-visit must be picked up next time. Proved by
      polling twice with a message timestamped between the two.
    */
    wire([{ chat_id: '919811533633' }], [customerSaid('first', RECENT, 'wamid.A')]);
    await pollWhatsMarketingInbound();
    expect(received.calls).toHaveLength(1);

    // Same instant as the first visit. A watermark set to "now" would skip it.
    const during = new Date().toISOString().slice(0, 19).replace('T', ' ');
    wire([{ chat_id: '919811533633' }], [customerSaid('landed mid-visit', during, 'wamid.B')]);
    await pollWhatsMarketingInbound();
    expect(received.calls.map((c) => c.message.providerMessageId)).toContain('wamid.B');
  });

  it('looks back a quarter of an hour, because the vendor publishes late', async () => {
    /*
      The bug the owner hit on 20 September, and the reason this file exists at
      all. WhatsMarketing stamps a message with when it was sent and publishes
      it minutes later. A watermark set to "when this visit started" is
      therefore always ahead of what they will show next, and a message landing
      in that gap is skipped for ever while the poller reports success every
      minute.

      Proved by polling once with nothing to find — which moves the watermark —
      then offering a message stamped five minutes *before* that visit. Against
      a one-second watermark it is dropped; it must be stored.
    */
    wire([{ chat_id: '919891222206' }], []);
    await pollWhatsMarketingInbound();

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    wire(
      [{ chat_id: '919891222206' }],
      [customerSaid('hey', fiveMinutesAgo, 'wamid.LATE')],
    );

    expect((await pollWhatsMarketingInbound()).stored).toBe(1);
    expect(received.calls.at(-1)?.message.providerMessageId).toBe('wamid.LATE');
  });

  it('offers a message once, however many times it reads it', async () => {
    // The look-back re-reads the same quarter hour every minute. The database
    // would refuse each repeat, but `receiveInbound` resolves the contact
    // before it opens its transaction, so the repeat is not free.
    const justNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
    wire([{ chat_id: '919891222206' }], [customerSaid('hey', justNow, 'wamid.ONCE')]);

    await pollWhatsMarketingInbound();
    await pollWhatsMarketingInbound();
    await pollWhatsMarketingInbound();

    const offered = received.calls
      .filter((c) => c.message.providerMessageId === 'wamid.ONCE');
    expect(offered).toHaveLength(1);
  });

  it('does nothing at all when another provider is the live one', async () => {
    active.name = 'whatsapp_gupshup';
    wire([{ chat_id: '919811533633' }], [customerSaid('hey', RECENT)]);
    expect(await pollWhatsMarketingInbound()).toEqual({ checked: 0, stored: 0 });
    expect(received.calls).toHaveLength(0);
  });

  it('does nothing when nothing is configured', async () => {
    credentials.value = {};
    config.value = {};
    expect(await pollWhatsMarketingInbound()).toEqual({ checked: 0, stored: 0 });
  });

  it('reads their refusal as a refusal, and says so where somebody can see it', async () => {
    /*
      HTTP 200 with status "0" is how they say no, and reading it as "no
      messages" looks exactly like a quiet afternoon. This poller ran ten times
      against production storing nothing, and from outside the container there
      was no way to tell a refused token from an unreachable vendor from nobody
      having written. The outcome goes on the integration row now.
    */
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ status: '0', message: 'Authentication failed' }),
    } as unknown as Response)));
    expect(await pollWhatsMarketingInbound()).toEqual({ checked: 0, stored: 0 });
    expect(reported.calls.at(-1)?.ok).toBe(false);
    expect(reported.calls.at(-1)?.detail).toMatch(/Authentication failed/);
  });

  it('survives the vendor being down, and names that too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(pollWhatsMarketingInbound()).resolves.toEqual({ checked: 0, stored: 0 });
    expect(reported.calls.at(-1)?.ok).toBe(false);
    expect(reported.calls.at(-1)?.detail).toMatch(/ECONNRESET/);
  });

  it('names the cause when it can see a message and stores it anyway not', async () => {
    /*
      The one that was open on production on 20 September: a customer message
      newer than the watermark, and `stored 0` in the same sentence. A bare
      count cannot say whether the row had no id, carried a shape the reader
      refuses to guess at, or was turned down by the store — and those need
      three different fixes. Here the row has no `wa_message_id`.
    */
    wire(
      [{ chat_id: '919891222206' }],
      [{ sender: 'subscriber', conversation_time: RECENT,
         message_content: JSON.stringify({ type: 'text', text: { body: 'hey' } }) }],
    );

    expect((await pollWhatsMarketingInbound()).stored).toBe(0);
    expect(received.calls).toHaveLength(0);
    const detail = reported.calls.at(-1)?.detail ?? '';
    expect(detail).toMatch(/dropped past the watermark: 1 with no id/);
    // And whose message it was, which is what somebody waiting by their phone asks.
    expect(detail).toMatch(/visible anywhere: .* from 919891222206/);
  });

  it('says how much it looked at even on a quiet visit', async () => {
    // "Checked 1, stored 0" and "could not reach them" look identical from
    // outside, and only one of them needs somebody to act.
    wire([{ chat_id: '919811533633' }], [customerSaid('ancient', OLD)]);
    await pollWhatsMarketingInbound();
    expect(reported.calls.at(-1)?.ok).toBe(true);
    expect(reported.calls.at(-1)?.detail).toMatch(/listed 1 subscriber; read 1 thread; stored 0 new messages/);
    /*
      And the number that separates the two causes of "stored 0": the poller
      cannot see the message, or it can see it and has already passed it. Here
      it can see one from 1 September, which is the second case.
    */
    expect(reported.calls.at(-1)?.detail).toMatch(/newest customer message visible anywhere: 2026-09-01T09:00:00/);
  });
});

describe('reading their message_content', () => {
  it('finds the text in the Meta object they wrap it in', () => {
    expect(textOfMessage(JSON.stringify({ type: 'text', text: { body: 'hello' } })).text).toBe('hello');
  });

  it('keeps a picture as media with its caption as the body', () => {
    const out = textOfMessage(JSON.stringify({
      type: 'image', image: { link: 'https://x/y.jpg', caption: 'the balcony', mime_type: 'image/jpeg' },
    }));
    expect(out.media?.link).toBe('https://x/y.jpg');
    expect(out.text).toBe('the balcony');
  });

  it('takes a plain string at face value', () => {
    expect(textOfMessage('just text').text).toBe('just text');
  });

  it('returns nothing rather than inventing something for a shape it cannot read', () => {
    /*
      A message stored with invented text is worse than one visibly missing:
      nobody goes looking for it. The poller logs the body instead.
    */
    expect(textOfMessage(JSON.stringify({ interactive: { nested: {} } })).text).toBeNull();
    expect(textOfMessage(undefined).text).toBeNull();
  });
});
