import { afterEach, describe, expect, it, vi } from 'vitest';

let card: Record<string, unknown> | undefined = { datasetId: '515009942931918', stages: 'Qualified, Visit Done, Won' };
let auditRows: Record<string, unknown>[] = [];
let alreadySent: Record<string, unknown>[] = [];
const queries: string[] = [];

vi.mock('../src/core/settings/integrations.js', () => ({
  getIntegrationConfig: () => card,
  getIntegrationCredentials: () => ({ accessToken: 'secret-token' }),
}));
vi.mock('../src/core/metadata/registry.js', () => ({
  getModule: async () => ({
    fields: [{
      name: 'lead_status', columnName: 'status',
      options: [{ value: 'New', label: 'New' }, { value: 'Contacted', label: 'Qualified' }, { value: 'Visit Done', label: 'Visit Done' }],
    }],
  }),
}));
vi.mock('../src/core/entity/recordService.js', () => ({
  getRecord: async () => ({ values: { country_code: '+91', mobile: '9876543210', email: 'a@b.com' } }),
}));
vi.mock('../src/db/pool.js', () => ({
  db: {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM ipy_audit')) return { rows: auditRows };
      if (sql.includes("status = 'sent'")) return { rows: alreadySent };
      return { rows: [] };
    },
    queryOne: async () => ({ id: 'claimed' }),
  },
}));

import { chooseWaitingStages, eventSecondsFor, sendWaitingStages } from '../src/integrations/leadsources/metaConversions';

const options = [{ value: 'New', label: 'New' }, { value: 'Contacted', label: 'Qualified' }, { value: 'Visit Done', label: 'Visit Done' }] as never;
const now = new Date('2026-11-02T14:00:00Z');
const ctx = {} as never;

function audit(recordId: string, to: string) {
  return { record_id: recordId, to_value: to, created_at: '2026-11-01T10:00:00Z', external_id: `lead-${recordId}`, received_at: '2026-10-31T10:00:00Z' };
}

afterEach(() => {
  vi.unstubAllGlobals();
  card = { datasetId: '515009942931918', stages: 'Qualified, Visit Done, Won' };
  auditRows = [];
  alreadySent = [];
  queries.length = 0;
});

describe('which moment Meta is told', () => {
  it('uses when the status changed', () => {
    expect(eventSecondsFor(new Date('2026-11-01T10:00:00Z'), new Date('2026-10-31T10:00:00Z'), now)).toBe(Date.parse('2026-11-01T10:00:00Z') / 1000);
  });
  it('never puts an event before its lead existed', () => {
    expect(eventSecondsFor(new Date('2026-10-31T09:00:00Z'), new Date('2026-10-31T10:00:00Z'), now)).toBe(Date.parse('2026-10-31T10:00:01Z') / 1000);
  });
  it('never puts an event in the future', () => {
    expect(eventSecondsFor(new Date('2026-11-03T00:00:00Z'), new Date('2026-10-31T10:00:00Z'), now)).toBe(Math.floor(now.getTime() / 1000));
  });
});

describe('which leads are waiting', () => {
  const change = (value: string) => ({ recordId: 'r1', statusValue: value, changedAt: new Date('2026-11-01T10:00:00Z'), leadId: 'L1', leadReceivedAt: new Date('2026-10-31T10:00:00Z') });

  it('keeps a lead whose stage is on the list, by its label, and names the event by that label', () => {
    const [one] = chooseWaitingStages([change('Contacted')], options, 'Qualified, Visit Done, Won', now);
    expect(one).toMatchObject({ recordId: 'r1', label: 'Qualified', leadId: 'L1' });
  });
  it('drops a lead that is not on a reported stage', () => {
    expect(chooseWaitingStages([change('New')], options, 'Qualified, Visit Done, Won', now)).toEqual([]);
  });
});

describe('sending the leads already on a stage', () => {
  it('refuses while a Test code is on, because a test event would be recorded as sent', async () => {
    card = { ...card, testEventCode: 'TEST2029' };
    await expect(sendWaitingStages(ctx)).rejects.toThrow(/Test code/);
  });

  it('only counts when no number is given, and tells Meta nothing', async () => {
    auditRows = [audit('r1', 'Contacted'), audit('r2', 'Visit Done'), audit('r3', 'New')];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendWaitingStages(ctx);
    expect(result).toMatchObject({ waiting: 2, sent: 0, byStage: { Qualified: 1, 'Visit Done': 1 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a number that is not the count it was shown', async () => {
    auditRows = [audit('r1', 'Contacted')];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendWaitingStages(ctx, 5)).rejects.toThrow(/changed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves out what Meta already has', async () => {
    auditRows = [audit('r1', 'Contacted'), audit('r2', 'Contacted')];
    alreadySent = [{ record_id: 'r1', event_name: 'Qualified' }];
    const result = await sendWaitingStages(ctx);
    expect(result.waiting).toBe(1);
  });

  it('sends one event per waiting lead, with its own time, and never the raw phone or email', async () => {
    auditRows = [audit('r1', 'Contacted'), audit('r2', 'Visit Done')];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendWaitingStages(ctx, 2);
    expect(result).toMatchObject({ waiting: 2, sent: 2, failed: { count: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(first.data[0]).toMatchObject({ event_name: 'Qualified', event_time: Date.parse('2026-11-01T10:00:00Z') / 1000 });
    expect(JSON.stringify(first)).not.toContain('9876543210');
    expect(JSON.stringify(first)).not.toContain('a@b.com');
    expect(first.test_event_code).toBeUndefined();
  });

  it('counts a refusal and carries on, with Meta\'s own words', async () => {
    auditRows = [audit('r1', 'Contacted'), audit('r2', 'Contacted')];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: '(#100) Invalid parameter' } }), { status: 400 })));
    const result = await sendWaitingStages(ctx, 2);
    expect(result).toMatchObject({ sent: 0, failed: { count: 2, reasons: ['(#100) Invalid parameter'] } });
  });
});
