import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './lib/store';
import { Spinner, ToastHost } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import Layout from './components/Layout';
import Login from './pages/Login';

// Route-level code splitting: every page ships as its own chunk and loads on
// first visit. Login and the shell stay eager so the first paint is instant.
const DashboardPage = lazy(() => import('./pages/Dashboard'));
const ListView = lazy(() => import('./pages/ListView'));
const RecordDetail = lazy(() => import('./pages/RecordDetail'));
const RecordEdit = lazy(() => import('./pages/RecordEdit'));
const Inbox = lazy(() => import('./pages/Inbox'));
const InventoryBoard = lazy(() => import('./pages/InventoryBoard'));
const Studio = lazy(() => import('./pages/Studio'));
const CallsPage = lazy(() => import('./pages/Calls'));
const ReportsPage = lazy(() => import('./pages/Reports'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const AdminPage = lazy(() => import('./pages/admin/Admin'));
const PortalDashboard = lazy(() => import('./pages/PortalDashboard'));
const PortalLeads = lazy(() => import('./pages/PortalLeads'));
const PortalBookings = lazy(() => import('./pages/PortalBookings'));
const PortalSubmitLead = lazy(() => import('./pages/PortalSubmitLead'));

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

            <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="dashboard/:id" element={<DashboardPage />} />

              <Route path="inbox" element={<Inbox />} />
              <Route path="inbox/:conversationId" element={<Inbox />} />

              <Route path="calls" element={<CallsPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="studio" element={<Studio />} />
              <Route path="inventory" element={<InventoryBoard />} />
              <Route path="inventory/:projectId" element={<InventoryBoard />} />

              <Route path="settings" element={<SettingsPage />} />
              <Route path="admin/*" element={<AdminPage />} />

              {/* Generic module routes — every module, seeded or custom, uses these. */}
              <Route path=":module" element={<ListView />} />
              <Route path=":module/new" element={<RecordEdit />} />
              <Route path=":module/:id" element={<RecordDetail />} />
              <Route path=":module/:id/edit" element={<RecordEdit />} />
            </Route>

            {/* Partner Portal routes — must come before the catch-all :module route. */}
            <Route path="/portal" element={<RequireAuth><PortalDashboard /></RequireAuth>}>
              <Route index element={<Navigate to="/portal/overview" replace />} />
              <Route path="overview" element={<PortalDashboard />} />
              <Route path="leads" element={<PortalLeads />} />
              <Route path="leads/new" element={<PortalSubmitLead />} />
              <Route path="bookings" element={<PortalBookings />} />
            </Route>

            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <ToastHost />
    </>
  );
}
