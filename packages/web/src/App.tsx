import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './lib/store';
import { Spinner, ToastHost } from './components/ui';
import Layout from './components/Layout';
import Login from './pages/Login';
import DashboardPage from './pages/Dashboard';
import ListView from './pages/ListView';
import RecordDetail from './pages/RecordDetail';
import RecordEdit from './pages/RecordEdit';
import Inbox from './pages/Inbox';
import InventoryBoard from './pages/InventoryBoard';
import CallsPage from './pages/Calls';
import ReportsPage from './pages/Reports';
import SettingsPage from './pages/Settings';
import AdminPage from './pages/admin/Admin';

function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { user, loading } = useApp();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner className="h-6 w-6 text-brand-600" />
          <p className="text-sm text-slate-500">Loading iPropy…</p>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

export default function App(): JSX.Element {
  const bootstrap = useApp((s) => s.bootstrap);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  return (
    <>
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

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <ToastHost />
    </>
  );
}
