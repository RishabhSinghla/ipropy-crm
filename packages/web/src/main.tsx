import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

// Register the service worker (public/sw.js) — this is what makes the CRM
// installable on a phone, lets the shell open instantly, and receives push
// notifications when the app is closed. Failure is non-fatal by design — the
// app runs perfectly well without it, so a browser that refuses registration
// (older iOS, private mode) just loses installability and alerts.
//
// In dev it registers with `?dev=1`, which the worker reads to switch its
// caching half off: push has to be testable before the app is deployed, but
// caching dev bundles would serve stale code and fight Vite's HMR.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const url = import.meta.env.PROD ? '/sw.js' : '/sw.js?dev=1';
    void navigator.serviceWorker.register(url).catch(() => undefined);
  });
}
