import { describe, expect, it } from 'vitest';
import type { FieldMeta, PicklistOption } from '@ipropy/shared';
import { mapFacebookAnswers, matchOption } from '../src/integrations/leadsources/facebookAnswers.js';
import { normalizeFacebook } from '../src/integrations/leadsources/capture.js';

const option = (value: string): PicklistOption => ({ value, label: value, color: null, sequence: 0, isActive: true });
const field = (name: string, label: string, uitype: string, options?: string[]): FieldMeta =>
  ({ name, label, uitype, isActive: true, displayType: 'default', options: options?.map(option) }) as unknown as FieldMeta;

const FIELDS = [
  field('budget', 'Budget', 'currency'),
  field('possession_timeline', 'Possession Timeline', 'picklist',
    ['Immediate', 'Within 1 Month', '1-3 Months', '3-6 Months', '6-12 Months', 'Just Exploring']),
  field('purpose', 'Purpose', 'picklist', ['Self Use', 'Investment']),
  field('occupation', 'Occupation', 'string'),
  field('status', 'Status', 'picklist', ['New']),
];

// The answers the 16 October 2026 form actually sent.
const NEW_FORM = [
  { name: 'full_name', values: ['A Buyer'] },
  { name: 'phone_number', values: ['+919811577100'] },
  { name: 'are_you_looking_to_buy_a_builder_floor_in_greenfields_colony,_faridabad?', values: ['yes,_only_in_greenfields_colony'] },
  { name: 'what_is_your_preferred_budget_range?', values: ['₹1.7_cr_-_₹2_cr_·__(_200_sq._yds.)'] },
  { name: 'when_do_you_plan_to_buy?', values: ['1_to_3_months'] },
];

describe('Facebook form answers', () => {
  it('files the new form\'s budget and timeline, which the old spelling missed', () => {
    const filled = mapFacebookAnswers(NEW_FORM, FIELDS, {});
    expect(filled.budget).toBe(20_000_000);
    expect(filled.possession_timeline).toBe('1-3 Months');
  });

  it('reads the budget for a repeat enquiry too, whatever the question says', () => {
    const lead = normalizeFacebook({ id: 'l1', field_data: NEW_FORM });
    expect(lead.budgetMax).toBe(20_000_000);
  });

  it('leaves an answer in the note when no dropdown option fits, instead of refusing the lead', () => {
    const filled = mapFacebookAnswers([{ name: 'when_do_you_plan_to_buy?', values: ['after_diwali'] }], FIELDS, {});
    expect(filled.possession_timeline).toBeUndefined();
  });

  it('matches "just looking" to "Just Exploring" and "asap" to "Immediate"', () => {
    expect(matchOption('just_looking', FIELDS[1].options)?.value).toBe('Just Exploring');
    expect(matchOption('asap', FIELDS[1].options)?.value).toBe('Immediate');
  });

  it('files an answer under a field whose label the question names, with no list to maintain', () => {
    const filled = mapFacebookAnswers([{ name: 'what_is_your_occupation?', values: ['doctor'] }], FIELDS, {});
    expect(filled.occupation).toBe('doctor');
  });

  it('never lets an answer set what the CRM decides, such as the status', () => {
    const filled = mapFacebookAnswers([{ name: 'what_is_your_status?', values: ['new'] }], FIELDS, {});
    expect(filled.status).toBeUndefined();
  });

  it('keeps a value the form already supplied', () => {
    const filled = mapFacebookAnswers(NEW_FORM, FIELDS, { budget: 5_000_000 });
    expect(filled.budget).toBeUndefined();
  });

  it('does nothing for a form with no extra questions', () => {
    expect(mapFacebookAnswers([{ name: 'full_name', values: ['A'] }], FIELDS, {})).toEqual({});
    expect(mapFacebookAnswers(undefined, FIELDS, {})).toEqual({});
  });
});
