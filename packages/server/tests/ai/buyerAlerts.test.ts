import { describe, expect, it } from 'vitest';
import { describeRepAlert, groupMatchesByRep } from '../../src/ai/actions.js';

const buyer = (label: string, ownerId: string | null, score = 90) => ({
  recordId: label.toLowerCase().replace(/\s+/g, '-'), label, ownerId, score,
});

describe('who a buyer-match alert goes to', () => {
  it('sends one alert per rep, not one per buyer', () => {
    const byRep = groupMatchesByRep(
      [buyer('Riya Sharma', 'rep-a'), buyer('Suresh Iyer', 'rep-b'), buyer('Arjun Bose', 'rep-a')],
      'unit-owner',
    );

    expect([...byRep.keys()].sort()).toEqual(['rep-a', 'rep-b']);
    expect(byRep.get('rep-a')?.map((b) => b.label)).toEqual(['Riya Sharma', 'Arjun Bose']);
  });

  it('gives an unowned buyer to whoever owns the unit rather than dropping it', () => {
    // The most valuable enquiry in the list is often the one nobody has picked
    // up yet — losing it silently is the failure this guards.
    const byRep = groupMatchesByRep([buyer('Walk-in enquiry', null)], 'unit-owner');
    expect(byRep.get('unit-owner')?.map((b) => b.label)).toEqual(['Walk-in enquiry']);
  });

  it('drops a buyer nobody owns when the unit has no owner either', () => {
    expect(groupMatchesByRep([buyer('Walk-in enquiry', null)], null).size).toBe(0);
  });
});

describe('what a buyer-match alert says', () => {
  it('names the buyer when there is only one', () => {
    // On a lock screen the name is the entire value of the notification.
    expect(describeRepAlert([buyer('Riya Sharma', 'rep-a', 94)], 'B-110')).toEqual({
      title: 'Riya Sharma may want B-110',
      body: 'Riya Sharma (94%)',
    });
  });

  it('counts them when there are several, listing the strongest three', () => {
    const { title, body } = describeRepAlert(
      [buyer('A', 'r', 99), buyer('B', 'r', 88), buyer('C', 'r', 80), buyer('D', 'r', 72), buyer('E', 'r', 71)],
      'B-110',
    );
    expect(title).toBe('5 of your buyers match B-110');
    expect(body).toBe('A (99%), B (88%), C (80%) and 2 more');
  });
});
