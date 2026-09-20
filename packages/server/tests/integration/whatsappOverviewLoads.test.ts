/**
 * The Health screen's summary has to actually run against a real database.
 *
 * **20 September 2026.** `whatsAppOverview` counted templates with
 * `body LIKE '%{{%'`, and `ipy_whatsapp_template` has no column called `body`
 * — it is `body_text`. Postgres refuses the whole statement (42703), the route
 * answered 500, and the page's guard read `isLoading || !data`, so a failed
 * request wore the loading skeleton for ever. The owner met an empty grey box
 * on two URLs with nothing on screen to say why.
 *
 * **Nothing cheaper than this could have caught it.** The SQL is a string, so
 * typecheck cannot see the column; a unit test with a mocked `db.query`
 * accepts any statement at all. It is rule 8's neighbour — the same class of
 * bug, found the same way, and the answer is the same: run it against a real
 * database and read the row back.
 *
 * So this test is deliberately thin. It does not assert business meaning; it
 * asserts that every query in there is one Postgres will accept, which is the
 * thing that broke.
 */
import { describe, expect, it } from 'vitest';
import { whatsAppOverview } from '../../src/integrations/whatsapp/business/overview.js';

describe('the WhatsApp Health summary', () => {
  it('runs every one of its queries against a real database', async () => {
    // Throwing here is the failure. A wrong column name never gets further
    // than this line, which is exactly where it should stop.
    const overview = await whatsAppOverview();

    expect(overview).toBeTruthy();
    expect(typeof overview.connected).toBe('boolean');
    expect(Array.isArray(overview.capabilities)).toBe(true);
    expect(Array.isArray(overview.stillTheirs)).toBe(true);

    // Every count is a number rather than a string: `COUNT(*)` comes back as
    // text from pg, and a screen printing "0" from a string reads the same as
    // one printing it from a number right up until somebody adds two together.
    for (const value of [
      overview.conversations.total, overview.conversations.windowOpen,
      overview.conversations.unlinked, overview.conversations.unread,
      overview.messages.inboundToday, overview.messages.outboundToday,
      overview.messages.failedToday, overview.messages.deliveredToday,
      overview.templates.total, overview.templates.approved, overview.templates.unmapped,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
