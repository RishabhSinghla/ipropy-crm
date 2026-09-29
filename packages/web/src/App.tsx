import { type JSX, lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './lib/store';
import { isInstalledApp } from './lib/native';
import { Spinner, ToastHost } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import Login from './pages/Login';

// Route-level code splitting: every page ships as its own chunk and loads on
// first visit. Login and the shell stay eager so the first paint is instant.
// Lazy, like the pages. Layout pulls in socket.io-client, the realtime
// listener and the AI assistant — and as a static import it shipped all of
// that to /s/:token too, where a buyer with no account is looking at five
// photos on mobile data. Nothing there ever mounts it.
const Layout = lazy(() => import('./components/Layout'));
/*
  The app's own shell. Lazy like everything else, so a browser never downloads
  it — `isNative` is false there and this chunk is never asked for.
*/
const MobileShell = lazy(() => import('./mobile/Shell'));
const DashboardPage = lazy(() => import('./pages/Dashboard'));
const ListView = lazy(() => import('./pages/ListView'));

/**
 * A list, and a way to arrive at one as if it were a fresh visit.
 *
 * **28 September 2026, the owner:** *"When we Click Save and Next from the
 * Call deck, then the new window open in same window of entire CRM instead of
 * Next record."* Save & next used `window.location.assign`, which reloads the
 * whole CRM — sign-in, metadata, every chunk — so the rep watched the app boot
 * between one call and the next.
 *
 * It could not simply navigate, and that is what this fixes. The next record
 * usually lives on the same `/leads` route with a *different* filter, sort and
 * page, and React Router keeps one `ListView` mounted across that — its own
 * list state then overwrites the new URL before adopting it, leaving the
 * selected card several pages away. A full reload was the blunt way to get a
 * clean mount.
 *
 * So the hand-off carries a stamp in the navigation's own state and this
 * remounts on it. A fresh `ListView` hydrates the captured queue exactly as a
 * reload did, and nothing else is downloaded again. **Only this hand-off
 * changes the key** — an ordinary filter, sort or page change writes no state,
 * so a rep working a list is never remounted under their own cursor.
 */
function ListRoute(): JSX.Element {
  const { state } = useLocation();
  const handoff = (state as { callDeckHandoff?: number } | null)?.callDeckHandoff;
  return <ListView key={handoff ? `handoff-${handoff}` : undefined} />;
}
const RecordDetail = lazy(() => import('./pages/RecordDetail'));
const RecordEdit = lazy(() => import('./pages/RecordEdit'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const SharedPropertyPage = lazy(() => import('./pages/SharedProperty'));
const ChatsPage = lazy(() => import('./pages/BusinessChats'));
const SharedMatchesPage = lazy(() => import('./pages/SharedMatches'));
const PublicFormPage = lazy(() => import('./pages/PublicForm'));
const SiteCapture = lazy(() => import('./pages/SiteCapture'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const ReportsPage = lazy(() => import('./pages/Reports'));
const WhatsAppPage = lazy(() => import('./pages/WhatsApp'));
const CallsPage = lazy(() => import('./pages/Calls'));
const AdminPage = lazy(() => import('./pages/admin/Admin'));

function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { user, loading } = useApp();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner className="h-6 w-6 text-brand-600" />
          <p className="text-sm text-muted">Loading iPropy…</p>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

function PageLoader(): JSX.Element {
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center">
      <Spinner className="h-6 w-6 text-brand-600" />
    </div>
  );
}

export default function App(): JSX.Element {
  const bootstrap = useApp((s) => s.bootstrap);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  return (
    <>
      {/* Outermost net: a crash in the shell (or in Login, which renders
          outside Layout) still shows a recoverable screen instead of white. */}
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<Login />} />

            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ForgotPassword />} />
            {/* Public: a buyer opening a link has no account, so this sits
                outside RequireAuth alongside /login. */}
            <Route path="/s/:token" element={<SharedPropertyPage />} />
            {/* `/m/` for a set of them — `/s/` is one property and its token space is the same table. */}
            <Route path="/m/:token" element={<SharedMatchesPage />} />
            {/* Public too: the enquiry form a website visitor fills. */}
            <Route path="/f/:publicKey" element={<PublicFormPage />} />

            {/*
              Installed, so this is the app's own shell — a phone-shaped
              product, not the website at a narrow width.

              True of the native app and of the web app added to a Home
              Screen, which on an iPhone is the only kind of install Apple
              permits without a paid developer account. A browser *tab* still
              gets the responsive web layout below, unchanged: this is
              deliberately not a breakpoint, so the phone-width e2e specs keep
              testing what they were written against.
            */}
            {isInstalledApp ? (
              <Route path="/*" element={<RequireAuth><MobileShell /></RequireAuth>} />
            ) : (
            <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="dashboard/:id" element={<DashboardPage />} />

              <Route path="capture" element={<SiteCapture />} />

              <Route path="settings" element={<SettingsPage />} />
              {/* Above the generic `:module` route, like /chats: otherwise
                  "reports" is looked up as a module and 404s. */}
              <Route path="reports" element={<ReportsPage />} />
              {/* `/*` because the page routes its own tabs. `/chats` still
                  works and is what the icon beside a number opens — this moves
                  the door, not the room. */}
              <Route path="whatsapp/*" element={<WhatsAppPage />} />
              <Route path="calls" element={<CallsPage />} />
              {/* The official business number's shared inbox. Above the generic
                  `:module` route, which would otherwise treat "chats" as a
                  module name and 404 on the metadata lookup. It is no longer a
                  header tab — the WhatsApp icon beside a number is the way in,
                  and the page says so itself when no provider is switched on. */}
              <Route path="chats" element={<ChatsPage />} />
              <Route path="admin/*" element={<AdminPage />} />

              {/* Generic module routes — every module, seeded or custom, uses these. */}
              <Route path=":module" element={<ListRoute />} />
              <Route path=":module/new" element={<RecordEdit />} />
              <Route path=":module/:id" element={<RecordDetail />} />
            </Route>
            )}


            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <ToastHost />
    </>
  );
}
