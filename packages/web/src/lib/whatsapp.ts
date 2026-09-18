/**
 * The WhatsApp decisions that are not UI, kept where they can be proved.
 *
 * They live here rather than in the components because a component that
 * imports the app's store cannot be loaded by a `node` test at all — the store
 * reads `localStorage` as it is constructed. A rule worth a test is a rule
 * worth its own file.
 */

/** Digits only — a handle is matched on digits, never on the spacing a screen adds. */
export function waDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * Which control the WhatsApp composer offers, and why.
 *
 * Two independent facts decide it, and getting either wrong means a rep types
 * a paragraph WhatsApp will not carry:
 *
 *  * **The 24-hour window.** WhatsApp allows a free reply only for a day after
 *    the customer last wrote. After that, an approved template or nothing.
 *  * **What the live provider can do at all.** AiSensy's API sends approved
 *    templates and nothing else, window or no window, so a message box there
 *    would fail on every send.
 *
 * Kept out of the component so it can be proved without a browser — it is one
 * line of UI and the two rules behind it are the whole feature.
 */
export type ComposerMode = 'text' | 'template';

export function composerMode(capabilities: string[], windowOpen: boolean): ComposerMode {
  return capabilities.includes('text') && windowOpen ? 'text' : 'template';
}

/** What to say about a shut box, which is different in the two cases above. */
export function whyNoTextBox(capabilities: string[], providerName: string | null): string {
  return capabilities.includes('text')
    ? 'WhatsApp only carries a free reply for 24 hours after the customer last wrote, and that has passed. An approved template can still go.'
    : `${providerName ?? 'This provider'} sends approved templates only.`;
}
