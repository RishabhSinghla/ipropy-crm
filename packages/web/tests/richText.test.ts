// @vitest-environment jsdom
//
// DOMParser is the whole point: this sanitiser leans on the browser's own
// parser rather than a regex, because hand-rolled HTML sanitisers are a
// well-known way to be wrong. Testing it therefore needs a DOM.
import { describe, expect, it } from 'vitest';
import { looksLikeHtml, sanitiseRichText } from '../src/lib/utils';

/**
 * Notes that arrived as HTML.
 *
 * The Vtiger import carried a decade of notes across with their markup intact.
 * Drawn as plain text every one of them is a wall of tags with the sentence
 * buried inside; rendered raw, a note is a script somebody else wrote running
 * on the CRM's own origin. These pin the third way — keep the words and the
 * formatting, drop everything that can act.
 */
describe('looksLikeHtml', () => {
  it('recognises the shape the import actually produced', () => {
    expect(looksLikeHtml('<div style=""    ><div><p>Ye 3.30 pm tak aayega</p></div></div>')).toBe(true);
  });

  it('leaves ordinary typing alone, angle brackets included', () => {
    expect(looksLikeHtml('Call back before 3 pm')).toBe(false);
    expect(looksLikeHtml('budget < 50 L, area > 200 gaj')).toBe(false);
    // An @mention is the other half of the comment box and must not be
    // mistaken for markup.
    expect(looksLikeHtml('@Shikha Jha can you take this one')).toBe(false);
  });
});

describe('sanitiseRichText', () => {
  it('keeps the sentence and the paragraphs of a real imported note', () => {
    const out = sanitiseRichText(
      '<div style=""    ><div><p>Ye 3.30 pm tak aayega</p><p>Ye iska dusra number hai</p><p>9883859579</p></div>\n</div>',
    );
    expect(out).toContain('<p>Ye 3.30 pm tak aayega</p>');
    expect(out).toContain('9883859579');
    // The empty style attribute the import left on every note goes.
    expect(out).not.toContain('style');
  });

  it('drops a script outright, content and all', () => {
    const out = sanitiseRichText('<p>before</p><script>alert(1)</script><p>after</p>');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('script');
  });

  it('strips every event handler and inline style', () => {
    const out = sanitiseRichText('<p onclick="steal()" style="position:fixed" class="x">hello</p>');
    expect(out).toBe('<p>hello</p>');
  });

  it('unwraps a tag it does not know, keeping the words', () => {
    // A <font> or a <table> from an old CRM loses its formatting, never its
    // content — deleting the node would delete the note.
    const out = sanitiseRichText('<font color="red">Sirf C Block me hi chaiye</font>');
    expect(out).toBe('Sirf C Block me hi chaiye');
  });

  it('keeps a real link and makes it safe to click', () => {
    const out = sanitiseRichText('<a href="https://example.com/unit">the unit</a>');
    expect(out).toContain('href="https://example.com/unit"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(out).toContain('target="_blank"');
  });

  it('refuses a javascript: link but keeps its text', () => {
    const out = sanitiseRichText('<a href="javascript:alert(1)">click me</a>');
    expect(out).not.toContain('javascript');
    expect(out).toContain('click me');
  });

  it('survives an unclosed tag rather than throwing', () => {
    expect(() => sanitiseRichText('<p>half a note')).not.toThrow();
    expect(sanitiseRichText('<p>half a note')).toContain('half a note');
  });

  it('keeps nested lists, which is most of what a note uses', () => {
    const out = sanitiseRichText('<ul><li>C-3648</li><li>C-3308</li></ul>');
    expect(out).toBe('<ul><li>C-3648</li><li>C-3308</li></ul>');
  });
});
