/** Enter sends a chat message, Shift+Enter adds a line; never while an IME is composing a character. */
export function enterSends(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
