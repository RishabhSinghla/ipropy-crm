/**
 * The descriptions file, and the pass that rewrites the words inside it.
 *
 * Two programs write this file: the CRM builds the structure when the folder is
 * created, and the media worker replaces the written blocks once a model has
 * looked at the photographs. That is a split worth having — one place owns the
 * layout — and it only works if the headings the worker looks for are exactly
 * the ones the CRM wrote.
 *
 * These tests are that contract. They caught a real one: the worker's heading
 * pattern only matched capital letters, so "99ACRES" and "HOUSING.COM" silently
 * matched nothing and read as the model failing to answer.
 */
import { describe, expect, it } from 'vitest';
import { descriptionsText, PORTALS } from '../src/core/storage/propertyDetails.js';

const FACTS = ['Unit          A-1818', 'Configuration 4 BHK', 'Price         ₹1.45 Cr'];

function build(): string {
  return descriptionsText('A1818', FACTS, {
    title: 'placeholder title',
    description: 'placeholder description',
    caption: 'placeholder caption',
    hashtags: '#placeholder',
    portals: PORTALS.map((p) => ({ name: p.name, note: p.note, body: 'placeholder body' })),
    hindi: { caption: 'placeholder hindi', description: '' },
  });
}

/** The worker's pattern, kept identical on purpose. */
const HEADING = '[A-Z0-9][A-Z0-9 .&/-]*';

function replaceBlock(text: string, name: string, value: string): { text: string; matched: boolean } {
  const pattern = new RegExp(
    `(^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n-{10,}\\n(?:.*\\n)*?\\n)`
    + `((?:  .*\\n|\\n)*?)`
    + `(?=^${HEADING}\\n-{10,}|^${HEADING}\\n={10,})`,
    'm',
  );
  const body = value.split('\n').map((l) => (l.trim() ? `  ${l}\n` : '\n')).join('');
  const next = text.replace(pattern, (_m, head: string) => head + body + '\n');
  return { text: next, matched: next !== text };
}

describe('the descriptions file', () => {
  it('has a section for every portal the business lists on', () => {
    const text = build();
    for (const portal of PORTALS) {
      expect(text, `${portal.name} has no section`).toContain(portal.name.toUpperCase());
    }
  });

  it('keeps the facts and the folder map, which no model writes', () => {
    const text = build();
    expect(text).toContain('THE FACTS');
    expect(text).toContain('WHICH FOLDER GOES WHERE');
    expect(text).toContain('₹1.45 Cr');
  });
});

describe('replacing the written blocks', () => {
  it('swaps every block the worker writes', () => {
    let text = build();
    for (const name of ['TITLE', 'DESCRIPTION', 'CAPTION', 'HASHTAGS', 'HINDI']) {
      const result = replaceBlock(text, name, `real ${name.toLowerCase()}`);
      expect(result.matched, `${name} did not match`).toBe(true);
      text = result.text;
    }
    expect(text).toContain('real title');
    expect(text).toContain('real hindi');
    expect(text).not.toContain('placeholder title');
  });

  /**
   * The one that failed. Two of the three portals are called 99acres and
   * Housing.com, and a heading pattern of `[A-Z][A-Z ]+` matches neither — so
   * both sections stayed as placeholders and it read as the model refusing to
   * write them.
   */
  it('swaps a portal section whose name has a digit or a dot in it', () => {
    let text = build();
    for (const portal of PORTALS) {
      const result = replaceBlock(text, portal.name.toUpperCase(), `real ${portal.name} copy`);
      expect(result.matched, `${portal.name} did not match`).toBe(true);
      text = result.text;
    }
    expect(text).toContain('real 99acres copy');
    expect(text).toContain('real Housing.com copy');
    expect(text).toContain('real Magicbricks copy');
  });

  it('leaves the facts alone while replacing everything above them', () => {
    const { text } = replaceBlock(build(), 'HASHTAGS', '#faridabad #builderfloor');
    expect(text).toContain('#faridabad #builderfloor');
    expect(text).toContain('₹1.45 Cr');
    expect(text).toContain('WHICH FOLDER GOES WHERE');
  });

  it('does nothing to a heading that is not there', () => {
    const result = replaceBlock(build(), 'NOTASECTION', 'x');
    expect(result.matched).toBe(false);
  });
});
