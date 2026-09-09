/**
 * The email leg of the report flow.
 *
 * The owner's half of the deal: he reports a problem, a model reads it (and the
 * screenshots), and the whole thing — original words, the analysis, the
 * pictures — lands in his inbox. These tests pin the three behaviours that
 * make the flow trustworthy when parts of it are down, because the two ways
 * this can quietly fail are exactly the two that matter:
 *
 * - the model is unconfigured (the CRM's default state) — the email must still
 *   go out, saying so, rather than the report vanishing into the void;
 * - the report row is missing (deleted mid-flight) — nothing may be sent.
 *
 * The database, the AI client, the email transport and the storage driver are
 * all mocked at their module boundaries; this file needs no database and no
 * network, which is why it runs in the plain unit suite.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryOne = vi.fn();
const query = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  db: {
    queryOne: (...args: unknown[]) => queryOne(...args),
    query: (...args: unknown[]) => query(...args),
  },
}));

const complete = vi.fn();
vi.mock('../src/ai/client.js', () => ({ complete: (...args: unknown[]) => complete(...args) }));

const sendEmail = vi.fn();
vi.mock('../src/integrations/email/service.js', () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }));

const read = vi.fn();
vi.mock('../src/core/storage/index.js', () => ({
  getDriver: async () => ({ read }),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

process.env.REPORT_EMAIL_TO = 'owner@test.example';
const { analyzeAndEmail } = await import('../src/core/feedback/analyzeAndEmail.js');

const feedbackRow = {
  id: 'fb-1', text: 'Dropdown khul nahi raha', kind: 'bug', severity: 'blocking',
  module_name: 'properties', route: '/properties',
  reporter_first: 'Papa', reporter_last: 'Ji',
};

beforeEach(() => {
  queryOne.mockReset().mockResolvedValue(feedbackRow);
  query.mockReset().mockResolvedValue({ rows: [] });
  complete.mockReset().mockResolvedValue(null);
  sendEmail.mockReset().mockResolvedValue({ id: 'log-1', status: 'sent' });
  read.mockReset();
});

describe('the report email', () => {
  it('sends the report and the AI analysis to the owner', async () => {
    complete.mockResolvedValue({ text: '## Summary\nDropdown broken.' });
    await analyzeAndEmail('fb-1');

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('owner@test.example');
    expect(mail.subject).toContain('bug: blocking');
    expect(mail.subject).toContain('properties');
    expect(mail.html).toContain('Dropdown khul nahi raha');
    expect(mail.html).toContain('Dropdown broken.');
    // The analysis is written back onto the row, so the reporter's own
    // "Meri Reports" page shows what was sent.
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ai_summary'),
      ['fb-1', '## Summary\nDropdown broken.'],
    );
  });

  it('still emails when no model is configured — saying so, not silently', async () => {
    // complete() returns null when every provider is unconfigured or cooling
    // down. The email must go out anyway: a report that reaches the owner
    // unanalysed beats one that reaches nobody.
    await analyzeAndEmail('fb-1');

    expect(complete).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].html).toContain('AI analysis unavailable');
  });

  it('sends nothing when the report row is gone', async () => {
    queryOne.mockResolvedValue(null);
    await analyzeAndEmail('missing');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('attaches the screenshots it found on the record', async () => {
    const png = Buffer.from('not-really-a-png');
    query.mockImplementation((sql: string) =>
      /ipy_attachment/.test(sql)
        ? Promise.resolve({ rows: [{ id: 'a1', storage_key: 'k/1.png', mime_type: 'image/png' }] })
        : Promise.resolve({ rows: [] }),
    );
    read.mockResolvedValue(png);
    complete.mockResolvedValue({ text: '## Summary\nSeen in the screenshot.' });

    await analyzeAndEmail('fb-1');

    const mail = sendEmail.mock.calls[0][0];
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].filename).toBe('screenshot-1.png');
    expect(mail.attachments[0].content).toBe(png);
    // And the model saw the same bytes, so its analysis is grounded in what
    // the email carries — not in a description of a description.
    expect(complete.mock.calls[0][0].images).toEqual([
      { data: png, mimeType: 'image/png' },
    ]);
  });

  it('never lets a send failure escape into the submit path', async () => {
    // The caller fires this without awaiting; a throw here would surface as
    // an unhandled rejection, not an error the reporter could act on.
    sendEmail.mockRejectedValue(new Error('smtp down'));
    await expect(analyzeAndEmail('fb-1')).resolves.toBeUndefined();
  });
});
