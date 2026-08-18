import type { JSX } from 'react';
import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './lib/store';
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
const DashboardPage = lazy(() => import('./pages/Dashboard'));
const ListView = lazy(() => import('./pages/ListView'));
const RecordDetail = lazy(() => import('./pages/RecordDetail'));
const RecordEdit = lazy(() => import('./pages/RecordEdit'));
const Inbox = lazy(() => import('./pages/Inbox'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const CapturePage = lazy(() => import('./pages/Capture'));
const CaptureReviewPage = lazy(() => import('./pages/CaptureReview'));
const CaptureShootsPage = lazy(() => import('./pages/CaptureShoots'));
const SharedPropertyPage = lazy(() => import('./pages/SharedProperty'));
const Outreach = lazy(() => import('./pages/Outreach'));
const CallsPage = lazy(() => import('./pages/Calls'));
const ReportsPage = lazy(() => import('./pages/Reports'));
const SettingsPage = lazy(() => import('./pages/Settings'));
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

            <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="dashboard/:id" element={<DashboardPage />} />

                <Route path="inbox" element={<Inbox />} />
              <Route path="inbox/:conversationId" element={<Inbox />} />

              <Route path="calls" element={<CallsPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="capture" element={<CapturePage />} />
              <Route path="capture/review" element={<CaptureReviewPage />} />
              <Route path="capture/shoots" element={<CaptureShootsPage />} />
              <Route path="outreach" element={<Outreach />} />

              <Route path="settings" element={<SettingsPage />} />
              <Route path="admin/*" element={<AdminPage />} />

              {/* Generic module routes — every module, seeded or custom, uses these. */}
              <Route path=":module" element={<ListView />} />
              <Route path=":module/new" element={<RecordEdit />} />
              <Route path=":module/:id" element={<RecordDetail />} />
              <Route path=":module/:id/edit" element={<RecordEdit />} />
            </Route>


            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <ToastHost />
    </>
  );
}
