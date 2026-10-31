/**
 * What the photo preview tries, in order, before it gives up.
 *
 * The full-size picture first, then the small one the avatar itself shows (it
 * is known to load), then nothing — at which point the dialog shows initials
 * and says the photo is unavailable, rather than a broken-image icon.
 */
export function previewTries(fullUrl: string, thumbUrl: string): string[] {
  return fullUrl === thumbUrl ? [fullUrl] : [fullUrl, thumbUrl];
}

/** The address to show after `failed` attempts have errored, or null for "give up". */
export function previewAfter(tries: string[], failed: number): string | null {
  return tries[failed] ?? null;
}
