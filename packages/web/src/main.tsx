import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';
import { startErrorReporting } from './lib/errorReporting';
import { boot, isNative } from './lib/native';
import { startNativeBridges } from './lib/nativeBridges';
import { fetchUpdateInBackground, markBundleHealthy } from './lib/liveUpdate';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Don't retry auth/permission failures — they won't fix themselves.
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

/*
  Started before React renders, so a crash during the first paint is caught too.
  It fetches its own configuration and does nothing when none is set, so this
  line costs a CRM with reporting switched off exactly one request and no
  download.
*/
void startErrorReporting();

/*
  `boot()` resolves immediately in a browser. In the app it reads the server
  address and the stored refresh token out of native storage first, and both
  have to be in hand before the first render: the very first thing the app does
  is ask the server who is signed in, and doing that against the wrong host —
  or without the token that proves the session — is a login screen shown to
  somebody who is already logged in.
*/
/*
  `.catch` and not just `.then`. Rendering behind a promise means anything that
  rejects inside `boot()` — a plugin missing from an older build, storage the OS
  refused — takes the entire app down to a blank screen with no error and no way
  back. A server address that is merely the compiled-in default is a far better
  outcome than no app at all.
*/
void boot().catch(() => undefined).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );

  // Back button, deep links, push, connectivity — all no-ops in a browser.
  void startNativeBridges();

  /*
    This bundle has painted, so it works. Said before anything else, because
    the plugin puts the previous bundle back if it never hears it — which is
    what stops a bad deploy bricking a team's phones, and what makes a missing
    call here look like an app that silently never updates.
  */
  void markBundleHealthy().then(() => fetchUpdateInBackground(true));
});

// Register the service worker (public/sw.js) — this is what makes the CRM
// installable on a phone, lets the shell open instantly, and receives push
// notifications when the app is closed. Failure is non-fatal by design — the
// app runs perfectly well without it, so a browser that refuses registration
// (older iOS, private mode) just loses installability and alerts.
//
// In dev it registers with `?dev=1`, which the worker reads to switch its
// caching half off: push has to be testable before the app is deployed, but
// caching dev bundles would serve stale code and fight Vite's HMR.
//
// Not in the app. Capacitor already serves the bundle from the device, so the
// worker's whole job is done — and its navigation fallback would fight the
// local server for control of every page load. Push in the app comes from
// Firebase/APNs through the OS, not from this worker.
if ('serviceWorker' in navigator && !isNative) {
  window.addEventListener('load', () => {
    const url = import.meta.env.PROD ? '/sw.js' : '/sw.js?dev=1';
    void navigator.serviceWorker.register(url).catch(() => undefined);
  });
}
