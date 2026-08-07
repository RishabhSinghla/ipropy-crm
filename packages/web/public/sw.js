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
const VERSION = 'ipropy-v1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

self.addEventListener('install', (event) => {
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
