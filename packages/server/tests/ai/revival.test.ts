import { describe, expect, it } from 'vitest';
import { describeRepAlert } from '../../src/ai/actions.js';

const buyer = (label: string, score: number, revival?: string) => ({
  recordId: label, label, score, ownerId: 'rep', ...(revival ? { revival } : {}),
});

describe('an alert about somebody who already said no', () => {
  it('says so, instead of passing it off as a fresh enquiry', () => {
    // A rep walking into "you told me it was too expensive" unprepared loses
    // the call in its first ten seconds.
    const { title, body } = describeRepAlert(
      [buyer('Riya Sharma', 88, 'Lost on price — this one is ₹2.15 Cr, inside their ₹2.4 Cr budget')],
      'B-110',
    );
    expect(title).toBe('Riya Sharma said no to a price — this one may fit');
    expect(body).toContain('inside their ₹2.4 Cr budget');
  });

  it('counts them when the whole batch is revivals', () => {
    const { title } = describeRepAlert(
      [buyer('A', 90, 'Lost on price'), buyer('B', 85, 'Lost on price')],
      'B-110',
    );
    expect(title).toBe('2 buyers who said no may fit B-110');
  });

  it('flags the revivals inside a mixed batch without hiding the live ones', () => {
    const { title, body } = describeRepAlert(
      [buyer('Live One', 95), buyer('Said No', 80, 'Lost on price')],
      'B-110',
    );
    expect(title).toBe('2 of your buyers match B-110');
    expect(body).toContain('1 of them previously said no');
  });

  it('leaves an ordinary batch exactly as it was', () => {
    const { title, body } = describeRepAlert([buyer('Live One', 95)], 'B-110');
    expect(title).toBe('Live One may want B-110');
    expect(body).toBe('Live One (95%)');
  });
});
