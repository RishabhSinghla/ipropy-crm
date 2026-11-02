import { afterEach, describe, expect, it, vi } from 'vitest';

let testEventCode: string | undefined;
let newestLead: { external_id: string } | null = { external_id: '123456789012345678' };

vi.mock('../src/db/pool.js', () => ({ db: { queryOne: async () => newestLead } }));

vi.mock('../src/core/settings/integrations.js', () => ({
  getIntegrationConfig: () => ({ datasetId: '515009942931918', testEventCode }),
  getIntegrationCredentials: () => ({ accessToken: 'secret-token' }),
}));

import { testMetaConversions } from '../src/integrations/leadsources/metaConversions';

function metaAnswers(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  testEventCode = undefined;
  newestLead = { external_id: '123456789012345678' };
});

describe('the Meta Conversions API Test button', () => {
  it('names the dataset when Meta answers', async () => {
    metaAnswers(200, { id: '515009942931918', name: "iPropy's" });
    const result = await testMetaConversions();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("iPropy's");
  });

  it('returns Meta\'s own words when Meta refuses, instead of throwing', async () => {
    metaAnswers(400, { error: { message: '(#100) Missing permissions' } });
    const result = await testMetaConversions();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('(#100) Missing permissions');
  });

  it('still answers when Meta cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await testMetaConversions();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('network down');
  });

  it('never puts the token in the answer', async () => {
    metaAnswers(400, { error: { message: 'Invalid OAuth access token' } });
    const result = await testMetaConversions();
    expect(result.message).not.toContain('secret-token');
  });

  describe('with a test code on the card', () => {
    it('sends one test event, with a real lead id, under that code and says where to look', async () => {
      testEventCode = 'TEST2029';
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'x' }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const result = await testMetaConversions();
      expect(result.ok).toBe(true);
      expect(result.message).toContain('Test events');
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('/515009942931918/events');
      expect(init.method).toBe('POST');
      const sent = JSON.parse(String(init.body));
      expect(sent.test_event_code).toBe('TEST2029');
      expect(sent.data).toHaveLength(1);
      expect(sent.data[0].user_data.lead_id).toBe('123456789012345678');
    });

    it('returns Meta\'s refusal of the test event', async () => {
      testEventCode = 'TEST2029';
      metaAnswers(400, { error: { message: '(#100) Invalid parameter' } });
      const result = await testMetaConversions();
      expect(result).toEqual({ ok: false, message: 'Meta refused: (#100) Invalid parameter' });
    });

    it('says so, and sends nothing, when no Facebook lead has ever arrived', async () => {
      testEventCode = 'TEST2029';
      newestLead = null;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const result = await testMetaConversions();
      expect(result.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('says so when Meta takes nothing', async () => {
      testEventCode = 'TEST2029';
      metaAnswers(200, { events_received: 0 });
      expect((await testMetaConversions()).ok).toBe(false);
    });
  });

  it('never sends an event when there is no test code, only reads the dataset', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: '1', name: "iPropy's" }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await testMetaConversions();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
  });
});
