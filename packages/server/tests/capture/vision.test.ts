/**
 * Sending pictures to a model, and choosing which pictures to send.
 *
 * Both halves are pure and both are the kind of thing that is wrong silently.
 * A malformed content block comes back as a 400 from a provider, which the
 * fallback chain swallows as "that provider failed" — so a permanently broken
 * wire format looks exactly like a flaky free tier. And a sampler that quietly
 * takes the first six photos returns six angles of the same doorway while every
 * integration test still passes.
 */
import { describe, expect, it } from 'vitest';
import { userContent } from '../../src/ai/client.js';
import { spread } from '../../src/core/capture/vision.js';

const image = (byte: number) => ({ data: Buffer.from([byte, byte, byte]), mimeType: 'image/jpeg' });

describe('the OpenAI-compatible user turn', () => {
  it('stays a plain string when there are no pictures', () => {
    // The content-array form is spec, but it is the newer half of it and
    // several small OpenAI-compatible servers only ever implemented the
    // string. Every text feature in the product goes down this path.
    expect(userContent({ prompt: 'Score this lead' })).toBe('Score this lead');
    expect(userContent({ prompt: 'Score this lead', images: [] })).toBe('Score this lead');
  });

  it('sends pictures as data URLs, before the question', () => {
    const content = userContent({ prompt: 'What is this?', images: [image(1), image(2)] });

    expect(Array.isArray(content)).toBe(true);
    const parts = content as Exclude<typeof content, string>;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AQEB' },
    });
    // The question comes last, so it is read as being about the pictures.
    expect(parts[2]).toEqual({ type: 'text', text: 'What is this?' });
  });

  it('keeps the mime type it was given', () => {
    // A PNG announced as a JPEG is rejected by some providers and silently
    // mis-decoded by others.
    const content = userContent({
      prompt: 'x',
      images: [{ data: Buffer.from([255]), mimeType: 'image/png' }],
    }) as { type: string; image_url: { url: string } }[];
    expect(content[0]!.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('choosing which photos to look at', () => {
  const list = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  it('takes everything when the shoot is small', () => {
    expect(spread(list(4), 6)).toEqual([0, 1, 2, 3]);
    expect(spread(list(6), 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('spreads across the whole visit rather than taking the front', () => {
    // The failure this exists to prevent: the first six frames of a real
    // walkthrough are six angles of one doorway, and a model shown those
    // describes a doorway.
    const picked = spread(list(30), 6);
    expect(picked).toHaveLength(6);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(29);
    // Genuinely spread — not clustered at either end.
    expect(new Set(picked).size).toBe(6);
    expect(Math.min(...picked.slice(1).map((v, i) => v - picked[i]!))).toBeGreaterThan(3);
  });

  it('always includes the last photo', () => {
    // Often the outside of the building or the parking, which is the most
    // recognisable frame in the whole shoot.
    for (const n of [7, 13, 25, 100]) {
      expect(spread(list(n), 6).at(-1)).toBe(n - 1);
    }
  });

  it('handles the degenerate cases without throwing', () => {
    expect(spread([], 6)).toEqual([]);
    expect(spread(list(5), 1)).toEqual([0]);
    expect(spread(list(5), 0)).toEqual([0]);
  });

  it('does not mutate what it was given', () => {
    const original = list(10);
    spread(original, 3);
    expect(original).toEqual(list(10));
  });
});
