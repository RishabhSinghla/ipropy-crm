import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent loop, without a model and without a database.
 *
 * What is worth testing here is not whether the model is clever — that can only
 * be judged against a real provider on real data — but whether the *loop* is
 * safe when it is not. A weak free model is the normal case for this CRM
 * (AI-ARCHITECTURE.md), so every one of these is a thing a bad turn actually
 * does: naming a field the business deleted, asking for a thousand rows,
 * calling a tool that does not exist, never deciding to answer, or returning
 * nothing at all.
 *
 * Each of those must degrade to a smaller answer, never to a crash, an empty
 * reply, or a query the caller was not allowed to run.
 */
const completeJson = vi.fn();
const complete = vi.fn();
const listRecords = vi.fn();
const getRecord = vi.fn();
const getModule = vi.fn();

vi.mock('../../src/ai/client.js', () => ({
  completeJson: (...a: unknown[]) => completeJson(...a),
  complete: (...a: unknown[]) => complete(...a),
  REAL_ESTATE_SYSTEM: 'system',
}));

vi.mock('../../src/core/entity/recordService.js', () => ({
  listRecords: (...a: unknown[]) => listRecords(...a),
  getRecord: (...a: unknown[]) => getRecord(...a),
}));

vi.mock('../../src/core/metadata/registry.js', () => ({
  registry: { getModule: (...a: unknown[]) => getModule(...a) },
}));

const { runAgent } = await import('../../src/ai/agent.js');

const ctx = { user: { id: 'u1', fullName: 'Rishabh' } } as never;

const leadsModule = {
  name: 'leads',
  label: 'Leads',
  fields: [
    { name: 'full_name', label: 'Full Name', uitype: 'string', isActive: true, displayType: 'default', columnName: 'full_name' },
    { name: 'lead_status', label: 'Status', uitype: 'picklist', isActive: true, displayType: 'default', columnName: 'status', options: [{ value: 'New' }, { value: 'Contacted' }] },
  ],
};

beforeEach(() => {
  completeJson.mockReset();
  complete.mockReset();
  listRecords.mockReset();
  getRecord.mockReset();
  getModule.mockReset().mockResolvedValue(leadsModule);
});

describe('the agent loop', () => {
  it('looks something up, then answers from what it found', async () => {
    completeJson
      .mockResolvedValueOnce({ tool: 'count_records', args: { module: 'leads', filter: { logic: 'AND', conditions: [] } } })
      .mockResolvedValueOnce({ tool: 'answer', args: { text: 'You have 7 leads.' } });
    listRecords.mockResolvedValue({ total: 7, rows: [] });

    const result = await runAgent('how many leads', ctx);

    expect(result?.answer).toBe('You have 7 leads.');
    // The step is kept so the UI can show its working rather than asking to be
    // trusted on a bare number.
    expect(result?.steps).toHaveLength(1);
    expect(result?.steps[0].label).toBe('Counted leads: 7');
  });

  it('drops a condition naming a field this business does not have', async () => {
    /*
      The single most repeated failure in this codebase: code naming a column an
      admin deleted. A model guessing `budget_max` would otherwise take the whole
      query down with a 400 — and the question was answerable without it.
    */
    completeJson
      .mockResolvedValueOnce({
        tool: 'search_records',
        args: {
          module: 'leads',
          filter: { logic: 'AND', conditions: [
            { field: 'budget_max', operator: 'less_than', value: 5 },
            { field: 'lead_status', operator: 'equals', value: 'New' },
          ] },
        },
      })
      .mockResolvedValueOnce({ tool: 'answer', args: { text: 'Two new leads.' } });
    listRecords.mockResolvedValue({ total: 2, rows: [] });

    const result = await runAgent('new leads under 5', ctx);

    const passed = listRecords.mock.calls[0][2].filter;
    expect(passed.conditions).toHaveLength(1);
    expect(passed.conditions[0].field).toBe('lead_status');
    // And it says so, so the answer is not quietly about a different question.
    expect(result?.steps[0].observation).toContain('budget_max');
  });

  it('runs every query as the person asking, never with a wider scope', async () => {
    completeJson
      .mockResolvedValueOnce({ tool: 'count_records', args: { module: 'leads' } })
      .mockResolvedValueOnce({ tool: 'answer', args: { text: 'done' } });
    listRecords.mockResolvedValue({ total: 0, rows: [] });

    await runAgent('anything', ctx);

    // The caller's own context, not a system or elevated one. This is the whole
    // reason the agent is safe to point at real customer data.
    expect(listRecords.mock.calls[0][0]).toBe(ctx);
  });

  it('caps how many rows one search may pull back', async () => {
    completeJson
      .mockResolvedValueOnce({ tool: 'search_records', args: { module: 'leads', limit: 5000 } })
      .mockResolvedValueOnce({ tool: 'answer', args: { text: 'done' } });
    listRecords.mockResolvedValue({ total: 0, rows: [] });

    await runAgent('everything', ctx);

    expect(listRecords.mock.calls[0][2].pageSize).toBe(25);
  });

  it('treats a failed tool as something to report, not a crash', async () => {
    completeJson
      .mockResolvedValueOnce({ tool: 'search_records', args: { module: 'leads' } })
      .mockResolvedValueOnce({ tool: 'answer', args: { text: 'Could not read that.' } });
    listRecords.mockRejectedValue(new Error('column "x" does not exist'));

    const result = await runAgent('something', ctx);

    expect(result?.answer).toBe('Could not read that.');
    expect(result?.steps[0].observation).toContain('column "x" does not exist');
  });

  it('answers a tool it has never heard of rather than looping on it', async () => {
    completeJson
      .mockResolvedValueOnce({ tool: 'send_email', args: {} })
      .mockResolvedValueOnce({ tool: 'answer', args: { text: 'I cannot do that.' } });

    const result = await runAgent('email everyone', ctx);

    expect(result?.steps[0].observation).toContain('No tool called');
    // Nothing was executed. Writes go through the confirm-first path, and an
    // invented tool must not become a second way in.
    expect(listRecords).not.toHaveBeenCalled();
  });

  it('stops after a fixed number of tools even if the model never answers', async () => {
    completeJson.mockResolvedValue({ tool: 'count_records', args: { module: 'leads' } });
    listRecords.mockResolvedValue({ total: 1, rows: [] });
    complete.mockResolvedValue({ text: 'Here is what I found.' });

    const result = await runAgent('loop forever', ctx);

    expect(listRecords.mock.calls.length).toBeLessThanOrEqual(5);
    // The work is not thrown away — it asks once for the answer alone.
    expect(result?.answer).toBe('Here is what I found.');
  });

  it('hands back nothing when the model gives nothing on the first turn', async () => {
    // Null, so `ask()` falls through to the older single-shot paths. A provider
    // having a bad moment should degrade to the previous behaviour rather than
    // to an empty chat bubble.
    completeJson.mockResolvedValue(null);
    expect(await runAgent('hello', ctx)).toBeNull();
  });
});
