/**
 * What a refused WhatsApp message means, in words a rep can act on.
 *
 * **20 September 2026.** A template send reached Meta and came back
 * *"(Error Code : 131049 )In order to maintain a healthy ecosystem
 * engagement, the message failed to be delivered."* — which is what the owner
 * saw on a red bubble. It reads like a fault in the CRM and is not one: Meta
 * limits how many marketing template messages one person may receive, and
 * nothing on this side can lift that.
 *
 * So the code is translated and the provider's own sentence is **kept after
 * it**, never replaced. The original is what a support conversation with the
 * vendor is about, and a translation that hides it would make the next
 * unrecognised code unreadable.
 *
 * The codes below are Meta's documented cloud-API errors. They are written
 * from knowledge — `developers.facebook.com` is blocked by this container's
 * egress proxy — so an unrecognised code is passed through untouched rather
 * than guessed at. Being silent about a code is cheap; being wrong about one
 * sends a rep to fix the wrong thing.
 */
const MEANINGS: { code: string; plain: string }[] = [
  {
    code: '131049',
    plain: 'WhatsApp did not deliver this. It limits how many marketing messages '
      + 'one person receives, and this person has reached that limit for now. '
      + 'Wait for them to message you — then you can reply freely for 24 hours — '
      + 'or send a utility template (an update about something they asked for) '
      + 'rather than a promotional one.',
  },
  {
    code: '131047',
    plain: 'More than 24 hours have passed since this person last wrote, so only '
      + 'an approved template can go.',
  },
  {
    code: '131026',
    plain: 'This number cannot receive the message — it may not be on WhatsApp, '
      + 'or it may have blocked the business number.',
  },
  {
    code: '131048',
    plain: 'WhatsApp has paused sending from the business number because too many '
      + 'people marked its messages as spam. It lifts on its own.',
  },
  {
    code: '130429',
    plain: 'Too many messages went out at once and WhatsApp throttled this one. '
      + 'Trying again in a few minutes usually works.',
  },
  {
    code: '132000',
    plain: 'The template was sent with the wrong number of blanks filled in.',
  },
  {
    code: '132001',
    plain: 'WhatsApp does not have a template by that name and language. Sync the '
      + 'template list in Admin → WhatsApp Templates.',
  },
];

/**
 * Put a plain sentence in front of a provider's error, when its code is one we
 * recognise. Everything else comes back exactly as it arrived.
 */
export function whyItFailed(message: string): string {
  const hit = MEANINGS.find((entry) => message.includes(entry.code));
  return hit ? `${hit.plain} (${message.trim()})` : message;
}
