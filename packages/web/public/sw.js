/*
 * Minimal service worker — its job is to make the CRM installable and to keep
 * the shell loading instantly, NOT to serve stale business data.
 *
 * A CRM is the wrong place for aggressive offline caching: showing a salesperson
 * a cached lead stage that changed an hour ago is worse than showing nothing.
 * So the split is deliberate:
 *
 *   /api/*  — never touched. Always straight to the network, so records, and
 *             the permission checks behind them, are never served from a cache.
 *   assets  — cache-first. Vite fingerprints filenames (index-a1b2c3.js), so a
 *             cached entry can never be the wrong version; a deploy produces
 *             new names and the old ones are dropped on activate.
 *   navigations — network-first, falling back to the cached shell only when the
 *             device is genuinely offline. This is what stops a Render free-tier
 *             cold start (or a lift with no signal) showing the browser's error
 *             page instead of the app.
 */
const VERSION = 'ipropy-v2';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

/*
 * Registered as `/sw.js?dev=1` by a dev build. Push notifications need a
 * service worker, and a salesperson should be able to try them before the app
 * is deployed — but the caching half would serve stale bundles and fight
 * Vite's HMR, so in dev only the push half runs.
 */
const DEV = new URL(self.location.href).searchParams.get('dev') === '1';

self.addEventListener('install', (event) => {
  if (DEV) { event.waitUntil(self.skipWaiting()); return; }
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(['/', '/manifest.webmanifest'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (DEV) return;
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (media, fonts) go straight through
  if (url.pathname.startsWith('/api/')) return; // never cache API traffic — see header comment

  // App shell for SPA navigations.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/', { ignoreSearch: true }).then((r) => r ?? Response.error())),
    );
    return;
  }

  // Fingerprinted static assets.
  if (/\.(js|css|woff2?|png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(ASSETS).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});

/* -------------------------------------------------------------------------
 * Push notifications
 *
 * This is the half that works when the CRM is closed — the whole point of
 * push. The payload is written by core/notifications on the server.
 * ---------------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  let payload; // assigned by both branches below before any read
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push with a non-JSON body is not ours; show something rather than
    // nothing, since the browser will display its own generic notification
    // anyway if this handler throws.
    payload = { title: 'iPropy', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'iPropy';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/maskable-192.png',
      // Same tag replaces an earlier notification for the same record rather
      // than stacking five alerts about one lead.
      tag: payload.tag || 'ipropy',
      renotify: true,
      data: { link: payload.link || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  const target = new URL(link, self.location.origin).href;

  // Focus an existing tab if the CRM is already open rather than piling up
  // windows — and navigate it to the record the alert was about.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.navigate ? client.navigate(target).then((c) => c && c.focus()) : client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
