import { describe, expect, it } from 'vitest';
import { saveNextUrl } from '../src/lib/saveNextUrl';

describe('Save & Next split-queue destination', () => {
  it('keeps the active filtered view and opens the next queue row on the correct page', () => {
    expect(saveNextUrl('/leads?view=team&q=sector&filter=%7B%22x%22%3A1%7D&sort=created_at&dir=desc&pageSize=100&page=1&open=old', 'leads', 'next-row', 101))
      .toBe('/leads?view=team&q=sector&filter=%7B%22x%22%3A1%7D&sort=created_at&dir=desc&pageSize=100&page=2&open=next-row&dial=1');
  });

  it('uses the actual first page for a first-page neighbor and the default page size', () => {
    expect(saveNextUrl('/properties?view=mine&page=4', 'properties', 'next-row', 25))
      .toBe('/properties?view=mine&open=next-row&dial=1');
  });

  it('does not guess a page when the queue position is unavailable', () => {
    expect(saveNextUrl('/leads?view=team&page=7', 'leads', 'next-row', null))
      .toBe('/leads?view=team&page=7&open=next-row&dial=1');
  });
});
