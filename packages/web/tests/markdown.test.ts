/**
 * renderMarkdown feeds `dangerouslySetInnerHTML` in the AI panels, the
 * markdown dashboard widget and the document viewer, so its escaping is a
 * security boundary rather than a formatting nicety. These tests pin both
 * halves: that the supported syntax renders, and that nothing user-supplied
 * can become executable markup.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/utils';

describe('renderMarkdown — formatting', () => {
  it('renders headings', () => {
    expect(renderMarkdown('# Site visit notes')).toContain('<h1>Site visit notes</h1>');
    expect(renderMarkdown('## Budget')).toContain('<h2>Budget</h2>');
    expect(renderMarkdown('### Vastu')).toContain('<h3>Vastu</h3>');
  });

  it('renders bold and italics without confusing the two', () => {
    expect(renderMarkdown('**corner unit**')).toContain('<strong>corner unit</strong>');
    expect(renderMarkdown('*urgent*')).toContain('<em>urgent</em>');

    const both = renderMarkdown('*italic* and **bold**');
    expect(both).toContain('<em>italic</em>');
    expect(both).toContain('<strong>bold</strong>');
  });

  it('renders bullet and numbered lists', () => {
    const html = renderMarkdown('- Liked the corner unit\n- Wants Vastu review');
    expect(html).toContain('<ul>');
    expect(html.match(/<li>/g)).toHaveLength(2);

    expect(renderMarkdown('1. Call\n2. Site visit')).toContain('<li>Call</li>');
  });

  it('renders inline and fenced code', () => {
    expect(renderMarkdown('Run `npm run dev`')).toContain('<code>npm run dev</code>');
    expect(renderMarkdown('```\nSELECT 1\n```')).toContain('<pre><code>SELECT 1</code></pre>');
  });

  it('leaves markdown syntax inside code spans alone', () => {
    expect(renderMarkdown('`**not bold**`')).toContain('<code>**not bold**</code>');
  });
});

describe('renderMarkdown — escaping', () => {
  it('escapes HTML before any rule can emit a tag', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes tags hidden inside otherwise valid markdown', () => {
    const html = renderMarkdown('**<img src=x onerror=alert(1)>**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes ampersands so entities cannot be smuggled in', () => {
    expect(renderMarkdown('Tom &amp; Jerry')).toContain('&amp;amp;');
  });
});

describe('renderMarkdown — link safety', () => {
  it('renders http and https links, opened safely', () => {
    const html = renderMarkdown('[our site](https://ipropy.com)');
    expect(html).toContain('href="https://ipropy.com"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('renders mailto links', () => {
    expect(renderMarkdown('[email](mailto:hi@ipropy.com)')).toContain('href="mailto:hi@ipropy.com"');
  });

  it('refuses javascript: targets — escaping does not stop those', () => {
    const html = renderMarkdown('[tap me](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('javascript:alert(1)"');
  });

  it('refuses data: targets', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toContain('<a ');
  });

  it('refuses scheme-relative and relative targets', () => {
    expect(renderMarkdown('[x](//evil.example)')).not.toContain('<a ');
    expect(renderMarkdown('[x](/admin)')).not.toContain('<a ');
  });
  /**
   * A safe scheme is not enough if the value can leave its own attribute.
   *
   * The href is interpolated into `href="…"`, and the escape pass originally
   * covered only `&`, `<` and `>`. That let `[c](https://x"autofocus/onfocus=…)`
   * close the attribute and add its own: a real DOM parser saw
   * `href, autofocus, onfocus, target, rel` on the anchor. No angle bracket was
   * ever needed, so every `<script>` test above passed while this worked.
   *
   * The reachable input is not exotic — the document viewer renders uploaded
   * `.md` files through this function, so one attachment reaches everyone who
   * opens it, and AI answers pass through it too.
   */
  it('cannot break out of the href attribute with a double quote', () => {
    const html = renderMarkdown('[c](https://x"autofocus/onfocus=location=name)');
    expect(html).not.toMatch(/<a[^>]*\sautofocus/i);
    expect(html).not.toMatch(/<a[^>]*\son\w+=/i);
    expect(html).toContain('&quot;');
  });

  it('cannot break out with a single quote either', () => {
    const html = renderMarkdown("[c](https://x'onclick=alert)");
    expect(html).not.toMatch(/<a[^>]*\sonclick/i);
  });

  it('leaves quotes in ordinary prose readable', () => {
    const html = renderMarkdown('He said "hello" and it\'s fine');
    expect(html).toContain('&quot;hello&quot;');
    expect(html).toContain('it&#39;s');
    expect(html).not.toContain('<a ');
  });

  it('still renders a normal link untouched', () => {
    const html = renderMarkdown('[our site](https://ipropy.com/a-b_c?x=1)');
    expect(html).toContain('href="https://ipropy.com/a-b_c?x=1"');
  });
});
