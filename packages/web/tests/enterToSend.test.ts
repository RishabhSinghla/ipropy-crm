import { describe, expect, it } from 'vitest';
import { enterSends } from '../src/lib/enterToSend';

describe('enterSends', () => {
  it('sends on a plain Enter', () => expect(enterSends({ key: 'Enter', shiftKey: false })).toBe(true));
  it('leaves Shift+Enter as a new line', () => expect(enterSends({ key: 'Enter', shiftKey: true })).toBe(false));
  it('ignores Enter while an IME is composing', () => {
    expect(enterSends({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(enterSends({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });
  it('ignores other keys', () => expect(enterSends({ key: 'a', shiftKey: false })).toBe(false));
});
