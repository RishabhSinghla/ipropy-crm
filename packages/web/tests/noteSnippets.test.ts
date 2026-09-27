/**
 * The one-tap phrases under a notes box.
 *
 * **27 September 2026, the owner:** *"yes make those chips editable from a
 * dropdown."* His prototype drew three of them and the first build left them
 * out, because three business phrases written into a component are three
 * phrases no admin can change. They are a picklist now, so what is left to
 * pin is what happens when one is tapped — every rule below is something a rep
 * would otherwise have to undo by hand.
 */
import { describe, expect, it } from 'vitest';
import { appendSnippet } from '../src/lib/noteSnippets';

describe('adding a phrase to a note', () => {
  it('starts an empty note with the phrase, not a blank line', () => {
    expect(appendSnippet('', 'Price negotiable')).toBe('Price negotiable');
    expect(appendSnippet('   ', 'Price negotiable')).toBe('Price negotiable');
  });

  it('puts each phrase on its own line', () => {
    expect(appendSnippet('Spoke to the buyer.', 'Price negotiable'))
      .toBe('Spoke to the buyer.\nPrice negotiable');
    expect(appendSnippet('Spoke to the buyer.\nPrice negotiable', 'Loan required'))
      .toBe('Spoke to the buyer.\nPrice negotiable\nLoan required');
  });

  /*
    The chips exist to write faster. A note saying "Price negotiable" twice is
    a note somebody has to go back and edit, which is slower than not using
    them at all.
  */
  it('adds nothing when the phrase is already in the note', () => {
    const note = 'Price negotiable\nLoan required';
    expect(appendSnippet(note, 'Price negotiable')).toBe(note);
    expect(appendSnippet(note, 'Loan required')).toBe(note);
  });

  it('ignores a phrase that is only whitespace', () => {
    expect(appendSnippet('Spoke to the buyer.', '   ')).toBe('Spoke to the buyer.');
  });

  /*
    A note ending in a newline is the ordinary state after somebody presses
    Enter. Without the trim the phrase would land two lines down.
  */
  it('does not leave a blank line behind a trailing newline', () => {
    expect(appendSnippet('Spoke to the buyer.\n\n', 'Loan required'))
      .toBe('Spoke to the buyer.\nLoan required');
  });
});
