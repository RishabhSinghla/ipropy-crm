import { describe, expect, it } from 'vitest';
import { renderTemplate } from '@ipropy/shared';

/**
 * The message a real lead actually received:
 *
 *   Hi Rishabh, thanks for your interest in . I am iPropy Admin from iPropy.
 *
 * "Interested In" is optional free text and is empty on most leads, so the
 * seeded welcome message printed a full stop with nothing in front of it —
 * and did so on every lead, from the first day the workflow existed.
 */
const WELCOME =
  'Hi {{first_name|there}}, thanks for your interest in {{interested_project|our properties}}.'
  + ' I am {{owner_name}} from iPropy.';

describe('renderTemplate merge tags', () => {
  it('substitutes a value that is present', () => {
    expect(renderTemplate('Hi {{first_name}}', { first_name: 'Riya' })).toBe('Hi Riya');
  });

  it('uses the fallback when the field is empty', () => {
    const out = renderTemplate(WELCOME, {
      first_name: 'Rishabh', interested_project: '', owner_name: 'iPropy Admin',
    });
    expect(out).toBe('Hi Rishabh, thanks for your interest in our properties. I am iPropy Admin from iPropy.');
  });

  it('uses the fallback when the field is missing entirely', () => {
    expect(renderTemplate('in {{gone|nowhere}}', {})).toBe('in nowhere');
  });

  it('prefers the value over the fallback', () => {
    expect(renderTemplate('in {{x|nowhere}}', { x: 'Verdant Greens' })).toBe('in Verdant Greens');
  });

  it('treats whitespace as empty', () => {
    expect(renderTemplate('in {{x|nowhere}}', { x: '   ' })).toBe('in nowhere');
  });

  it('leaves no orphaned punctuation when a tag has no fallback', () => {
    expect(renderTemplate('interest in {{project}}.', {})).toBe('interest in.');
    expect(renderTemplate('Call new lead: {{first_name}} {{last_name}}', { first_name: 'Rishabh' }))
      .toBe('Call new lead: Rishabh');
    expect(renderTemplate('{{a}} — {{b}} — {{c}}', { a: 'Riya', c: '99105 00000' }))
      .toBe('Riya — — 99105 00000');
  });

  it('does not reformat a template where everything resolved', () => {
    // The tidy pass must never touch deliberate spacing, so it only runs when
    // a tag actually blanked. Two spaces here are the author's.
    const template = 'Line one\n\n  indented  {{x}}  ';
    expect(renderTemplate(template, { x: 'y' })).toBe('Line one\n\n  indented  y  ');
  });

  it('still resolves dotted paths', () => {
    expect(renderTemplate('{{owner.first_name}}', { owner: { first_name: 'Divya' } })).toBe('Divya');
  });

  it('renders zero rather than treating it as absent', () => {
    expect(renderTemplate('{{n|none}}', { n: 0 })).toBe('0');
  });
});
