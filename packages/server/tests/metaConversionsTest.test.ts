import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/settings/integrations.js', () => ({
  getIntegrationConfig: () => ({ datasetId: '515009942931918' }),
  getIntegrationCredentials: () => ({ accessToken: 'secret-token' }),
}));

import { testMetaConversions } from '../src/integrations/leadsources/metaConversions';

function metaAnswers(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

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
});
