/**
 * Telling the person at the desk that a customer has written on WhatsApp.
 *
 * The server already does the hard part: `notify()` writes the bell row and
 * pings this tab over the socket (see `tellSomebody` in the inbound path). All
 * that was missing on a laptop was something you would actually notice — the
 * bell only changes a number in a corner. So a WhatsApp notification now does
 * two visible things:
 *
 *  1. A toast inside the CRM, which stays for twelve seconds and opens the chat
 *     when clicked.
 *  2. A desktop notification from the browser when the CRM tab is not the one
 *     being looked at — because a toast on a hidden tab reaches nobody.
 *
 * The second is skipped when this browser has already turned on push in
 * Settings: the push service shows its own, and two of the same would teach
 * people to switch both off.
 */
import { currentSubscription } from './push';
import { toast, useToasts } from './store';

export interface LiveNotification {
  id?: string;
  kind?: string;
  title?: string;
  body?: string | null;
  link?: string | null;
}

const TOAST_STAYS_MS = 12_000;

export function isWhatsAppMessage(note: LiveNotification | undefined): boolean {
  return note?.kind === 'whatsapp';
}

export async function announceWhatsApp(note: LiveNotification): Promise<void> {
  const title = note.title ?? 'New WhatsApp message';
  const body = note.body ?? undefined;
  const link = note.link ?? '/whatsapp/chats';

  useToasts.getState().push({ kind: 'info', title, body, link, stayFor: TOAST_STAYS_MS });

  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (await currentSubscription().catch(() => null)) return;

  const shown = new Notification(title, { body, tag: note.id, icon: '/icons/icon-192.png' });
  shown.onclick = () => {
    window.focus();
    window.location.assign(link);
    shown.close();
  };
}

/**
 * Asks the browser once whether the CRM may show desktop notifications.
 *
 * Browsers only let a page ask after somebody has clicked something, and
 * refuse quietly otherwise, so this waits for the first click after login
 * rather than asking on arrival.
 */
export function askForDesktopNotificationsOnFirstClick(): () => void {
  if (!('Notification' in window) || Notification.permission !== 'default') return () => {};
  const ask = (): void => {
    void Notification.requestPermission().then((answer) => {
      if (answer === 'granted') toast.success('WhatsApp alerts are on', 'New messages will show on your desktop.');
    });
  };
  window.addEventListener('click', ask, { once: true });
  return () => window.removeEventListener('click', ask);
}
