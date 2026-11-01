/**
 * Which of the company's WhatsApp numbers an admin has chosen to send from. Empty means "automatic": the server uses the
 * lead owner's number and falls back to the company number. Remembered per browser tab only; everybody else is ignored
 * by the server, which always uses their own number.
 */
const KEY = 'ipropy.waNumberChoice';

export function chosenWaNumberId(): string | undefined {
  try { return sessionStorage.getItem(KEY) || undefined; } catch { return undefined; }
}

export function chooseWaNumber(id: string): void {
  try {
    if (id) sessionStorage.setItem(KEY, id); else sessionStorage.removeItem(KEY);
  } catch { /* private window: the choice simply is not remembered */ }
  window.dispatchEvent(new Event('ipropy:wa-number'));
}
