/**
 * Browser habits that quietly stop working once the CRM is an installed app.
 *
 * A webview is not a browser. It has no address bar, no tab to open, no
 * downloads tray and no notion of "save this file somewhere". The web code
 * that relies on those does not error when it runs inside the app — it simply
 * does nothing, which is the worst available outcome: a rep taps Export, the
 * button depresses, and no file ever appears anywhere.
 *
 * Each function here is the same action expressed twice: the browser way, and
 * the way the platform actually offers. On the web every one of them is the
 * original code path unchanged.
 */
import { isNative } from './native';

// ---------------------------------------------------------------------------
// Links that leave the app
// ---------------------------------------------------------------------------

/**
 * Open a URL outside the CRM — a wa.me hand-off, a portal listing, a map.
 *
 * `window.open(url, '_blank')` is the browser answer and returns null inside a
 * webview, so nothing happens. Worse is the near-miss: a webview that *does*
 * follow the link replaces the CRM with WhatsApp's web page, with no back
 * button and no way home, and the rep force-quits the app to recover.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isNative) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { Browser } = await import('@capacitor/browser');
  /*
    An in-app browser tab, not a jump to Chrome: it keeps the CRM alive
    underneath with a Done button that comes straight back. Android hands
    `wa.me` to the WhatsApp app itself before this ever renders, which is
    exactly what a rep expects from tapping a WhatsApp button.
  */
  await Browser.open({ url, presentationStyle: 'popover' });
}

/** Ring a number from the record. */
export function dial(phone: string): void {
  const clean = phone.replace(/[^\d+]/g, '');
  // `tel:` is not http, so the webview hands it to the OS on both platforms.
  // This is one of the few browser behaviours that survives the move intact.
  window.location.href = `tel:${clean}`;
}

// ---------------------------------------------------------------------------
// Files coming out of the CRM
// ---------------------------------------------------------------------------

/**
 * Hand the user a file the app has produced — an export, a document, a report.
 *
 * The web does this with a blob URL and an `<a download>` click. A webview has
 * no downloads folder to click into, so that anchor is inert: the export runs,
 * the server bills the query, and the rep is left looking at a dialog that
 * closed with nothing to show for it.
 *
 * Natively the file is written to the app's own documents directory and handed
 * to the system share sheet, which is where a phone user expects to choose
 * between WhatsApp, Drive, Files and email anyway.
 */
export async function deliverFile(blob: Blob, fileName: string): Promise<void> {
  if (!isNative) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }

  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);

  const base64 = await blobToBase64(blob);
  /*
    `Directory.Cache`, not `Documents`. An export is a thing being passed on,
    not a thing being kept, and Documents on iOS is user-visible storage that
    fills with `leads-export.csv` copies nobody ever deletes. The OS reclaims
    Cache on its own.
  */
  const written = await Filesystem.writeFile({
    path: fileName,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  });

  await Share.share({ title: fileName, url: written.uri });
}

/**
 * Fetch a file the server holds and hand it over.
 *
 * The web does this with a plain `<a download>` and the browser does the rest.
 * In the app that anchor is inert, so the bytes are fetched here and passed to
 * `deliverFile`. The URL already carries its own `access_token` (see
 * `authedFileUrl`), which is what lets a bare fetch read a permission-checked
 * file.
 */
export async function downloadFromUrl(url: string, fileName: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${fileName}`);
  await deliverFile(await res.blob(), fileName);
}

/** A blob as base64 without the `data:` prefix, which Filesystem rejects. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * `navigator.clipboard` needs a secure context, and iOS does not consider the
 * app's `capacitor://` origin to be one. Copying a share link — the single most
 * used copy in this CRM — therefore rejects on iPhone and nowhere else.
 */
export async function copyText(text: string): Promise<void> {
  if (isNative) {
    const { Clipboard } = await import('@capacitor/clipboard');
    await Clipboard.write({ string: text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

// ---------------------------------------------------------------------------
// Where the phone is
// ---------------------------------------------------------------------------

export interface Fix { latitude: number; longitude: number; accuracy: number }

/**
 * A position, once.
 *
 * `navigator.geolocation` exists inside a webview and answers nothing useful:
 * the app has to hold the OS permission and ask for it at the right moment,
 * and a webview that has not been granted it calls the error handler with a
 * generic denial. The plugin owns that conversation on both platforms.
 */
export async function currentPosition(timeoutMs: number): Promise<Fix> {
  if (isNative) {
    const { Geolocation } = await import('@capacitor/geolocation');
    const permission = await Geolocation.checkPermissions();
    if (permission.location !== 'granted') {
      const asked = await Geolocation.requestPermissions({ permissions: ['location'] });
      if (asked.location !== 'granted') throw new Error('Location permission denied');
    }
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: timeoutMs,
    });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
  }

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('No geolocation')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/** A position, repeatedly, until the returned function is called. */
export async function watchPosition(
  timeoutMs: number,
  onFix: (fix: Fix) => void,
  onError: (message: string) => void,
): Promise<() => void> {
  if (isNative) {
    const { Geolocation } = await import('@capacitor/geolocation');
    const permission = await Geolocation.checkPermissions();
    if (permission.location !== 'granted') {
      const asked = await Geolocation.requestPermissions({ permissions: ['location'] });
      if (asked.location !== 'granted') { onError('Location permission denied'); return () => undefined; }
    }
    const id = await Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: timeoutMs },
      (pos, err) => {
        if (err || !pos) { onError(err?.message ?? 'No position'); return; }
        onFix({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
    );
    return () => { void Geolocation.clearWatch({ id }); };
  }

  if (!navigator.geolocation) { onError('No geolocation'); return () => undefined; }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    }),
    (err) => onError(err.message),
    { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// ---------------------------------------------------------------------------
// Feel
// ---------------------------------------------------------------------------

/**
 * A short tap of feedback on a destructive or committing action.
 *
 * Silent on the web, where there is nothing to vibrate and a page that buzzed
 * would be a page nobody trusted.
 */
export async function tap(style: 'light' | 'medium' | 'heavy' = 'light'): Promise<void> {
  if (!isNative) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    const map = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
    await Haptics.impact({ style: map[style] });
  } catch { /* a device with no haptic engine is not a failure */ }
}
