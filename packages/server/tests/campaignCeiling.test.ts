/**
 * What a campaign is allowed to do to a phone book.
 *
 * This is the whole of the protection, so it is tested on its own, without a
 * database, walking every threshold. The reason it exists is in migration
 * `161`: a daily workflow whose conditions had emptied itself queued 40,515
 * WhatsApp messages to 20,209 people in this CRM, and nobody received one only
 * because no provider was connected.
 */
import { describe, expect, it } from 'vitest';
import {
  audienceVerdict, MOST_WE_WILL_SEND, NEEDS_CONFIRMING,
} from '../src/integrations/whatsapp/business/campaigns.js';

describe('who a campaign may be sent to', () => {
  it('lets an ordinary one through', () => {
    expect(audienceVerdict({ count: 40, expected: 40 })).toBeNull();
  });

  it('refuses when the audience has moved since it was shown', () => {
    /*
      The one that matters most. Somebody reads "340 people", a colleague edits
      the saved view, and the approval that follows must not quietly become a
      different campaign.
    */
    expect(audienceVerdict({ count: 341, expected: 340 }))
      .toMatch(/341 people now, not the 340 you were shown/);
    expect(audienceVerdict({ count: 12, expected: 340 })).not.toBeNull();
  });

  it('says so rather than sending nothing at all', () => {
    // Zero is not success. A campaign that reaches nobody is a mistake in the
    // audience, and the screen should say which.
    expect(audienceVerdict({ count: 0, expected: 0 })).toMatch(/Nobody in this audience/);
  });

  it('asks twice above the confirming line, and only above it', () => {
    expect(audienceVerdict({ count: NEEDS_CONFIRMING, expected: NEEDS_CONFIRMING })).toBeNull();
    expect(audienceVerdict({ count: NEEDS_CONFIRMING + 1, expected: NEEDS_CONFIRMING + 1 }))
      .toMatch(/large campaign/);
    expect(audienceVerdict({
      count: NEEDS_CONFIRMING + 1, expected: NEEDS_CONFIRMING + 1, confirmLarge: true,
    })).toBeNull();
  });

  it('refuses outright above the ceiling, confirmed or not', () => {
    // Twenty thousand has been queued by accident here once already. A number
    // that large is a mistake far more often than it is a decision, and
    // splitting a genuine one costs an afternoon rather than a reputation.
    const over = MOST_WE_WILL_SEND + 1;
    expect(audienceVerdict({ count: over, expected: over, confirmLarge: true }))
      .toMatch(/more than this CRM will send/);
  });

  it('keeps the ceiling well under the number that caused all this', () => {
    expect(MOST_WE_WILL_SEND).toBeLessThan(20_000);
    expect(NEEDS_CONFIRMING).toBeLessThan(MOST_WE_WILL_SEND);
  });
});
