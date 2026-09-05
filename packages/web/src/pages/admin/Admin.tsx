import SettingsAdmin from './SettingsAdmin';
import type { JSX } from 'react';
import { Suspense, lazy } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import {
  Activity, Blocks, Database, GitBranch, Globe, KeyRound, Layers, LayoutTemplate, MapPin,
  Columns3, ListTree, Plug, Settings2, Shield, Sliders, Sparkles, ToggleLeft, Users, Workflow,
  SlidersHorizontal,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/utils';
import { useApp } from '../../lib/store';

const ModuleBuilder = lazy(() => import('./ModuleBuilder'));
const ModuleManager = lazy(() => import('./ModuleManager'));
const LayoutDesigner = lazy(() => import('./LayoutDesigner'));
const PicklistManager = lazy(() => import('./PicklistManager'));
const UsersAdmin = lazy(() => import('./UsersAdmin'));
const RolesProfiles = lazy(() => import('./RolesProfiles'));
const SharingAdmin = lazy(() => import('./SharingAdmin'));
const WorkflowAdmin = lazy(() => import('./WorkflowAdmin'));
const IntegrationsAdmin = lazy(() => import('./IntegrationsAdmin'));
const SystemAdmin = lazy(() => import('./SystemAdmin'));
const TeamMap = lazy(() => import('./TeamMap'));
const ImportAdmin = lazy(() => import('./ImportAdmin'));
const BrandAdmin = lazy(() => import('./BrandAdmin'));
const ViewsAdmin = lazy(() => import('./ViewsAdmin'));

/*
  Every section names the capability that opens it.

  Admin was a route with no guard: the sidebar link was hidden from non-admins
  and the route was not, so a Sales Executive typing /admin/users was handed the
  whole control panel — Modules & Fields, Dropdowns, Roles & Profiles,
  Integrations, a "New user" button — every control of which answers 403 when
  pressed. The server was never fooled; the person was.

  Named per section rather than gated on `isAdmin`, because the answer is not
  binary. A Sales Manager holds `records.import` and no admin capability at all,
  and Import Data lives in here — one blanket check would have taken away the one
  screen they are meant to use.
*/
const SECTIONS = [
  {
    group: 'Customisation',
    items: [
      { path: 'modules', capability: 'admin.modules', label: 'Enable / Disable', icon: ToggleLeft, element: <ModuleManager /> },
      { path: 'fields', capability: 'admin.fields', label: 'Modules & Fields', icon: Blocks, element: <ModuleBuilder /> },
      { path: 'layouts', capability: 'admin.layouts', label: 'Layout Designer', icon: LayoutTemplate, element: <LayoutDesigner /> },
      { path: 'views', capability: 'admin.layouts', label: 'List View Tabs', icon: Columns3, element: <ViewsAdmin /> },
      { path: 'picklists', capability: 'admin.picklists', label: 'Dropdowns', icon: ListTree, element: <PicklistManager /> },
    ],
  },
  {
    group: 'Access',
    items: [
      { path: 'users', capability: 'admin.users', label: 'Users', icon: Users, element: <UsersAdmin /> },
      { path: 'roles', capability: 'admin.roles', label: 'Roles & Profiles', icon: Shield, element: <RolesProfiles /> },
      { path: 'sharing', capability: 'admin.sharing', label: 'Data Sharing', icon: KeyRound, element: <SharingAdmin /> },
      { path: 'map', capability: 'admin.users', label: 'Team map', icon: MapPin, element: <TeamMap /> },
    ],
  },
  {
    group: 'Automation',
    items: [
      { path: 'workflows', capability: 'admin.workflows', label: 'Workflows', icon: Workflow, element: <WorkflowAdmin /> },
      { path: 'import', capability: 'records.import', label: 'Import Data', icon: Database, element: <ImportAdmin /> },
    ],
  },
  {
    group: 'Platform',
    items: [
      { path: 'integrations', capability: 'admin.integrations', label: 'Integrations', icon: Plug, element: <IntegrationsAdmin /> },
      { path: 'settings', capability: 'admin.access', label: 'Settings', icon: SlidersHorizontal, element: <SettingsAdmin /> },
      { path: 'brand', capability: 'admin.access', label: 'Brand & Social', icon: Sparkles, element: <BrandAdmin /> },
      { path: 'system', capability: 'admin.audit', label: 'System & Audit', icon: Activity, element: <SystemAdmin /> },
    ],
  },
];

export default function AdminPage(): JSX.Element {
  const { user } = useApp();
  const allowed = new Set(user?.capabilities ?? []);
  const sections = SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => allowed.has(i.capability)) }))
    .filter((s) => s.items.length > 0);

  /*
    Nothing here for you, said plainly rather than by handing over a panel of
    buttons that all fail.

    A rep who follows an old link or types the address deserves a sentence, not
    a 403 the moment they touch anything.
  */
  if (sections.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <h2 className="text-base font-semibold">This is the admin area</h2>
          <p className="mt-2 text-sm text-muted">
            Your account does not manage the CRM&apos;s setup, so there is nothing for
            you here. Everything you need is on the other screens.
          </p>
          <Link to="/dashboard" className="btn-primary mt-4 inline-flex">Back to the dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    // A fixed 14rem rail is fine on a desktop and ruinous on a phone: it left
    // about 160px for the panel, which wrapped every label a character at a
    // time. Below `lg` the same destinations become a horizontally scrolling
    // strip above full-width content.
    <div className="flex h-full min-w-0 flex-col lg:flex-row">
      <nav className="shrink-0 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:w-56 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-3">
        <div className="mb-4 hidden items-center gap-2 px-1 lg:flex">
          <Settings2 className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold">Admin</h2>
        </div>

        {/* Mobile: one flat scrolling strip. The group headings are dropped
            rather than repeated — 12 destinations are quicker to scan in a row
            than 4 headings are to read. */}
        <div className="flex gap-1 overflow-x-auto px-2 py-2 lg:hidden">
          {sections.flatMap((s) => s.items).map((item) => (
            <NavLink
              key={item.path}
              to={`/admin/${item.path}`}
              className={({ isActive }) => cn(
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                isActive
                  ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300'
                  : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300',
              )}
            >
              <item.icon className="h-3.5 w-3.5 shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </div>

        <div className="hidden space-y-4 lg:block">
          {sections.map((section) => (
            <div key={section.group}>
              <p className="mb-1 px-3 text-2xs font-semibold uppercase tracking-wider text-muted">
                {section.group}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.path}
                    to={`/admin/${item.path}`}
                    className={({ isActive }) => cn('nav-item', isActive && 'nav-item-active')}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <Suspense fallback={
          <div className="flex h-full min-h-[50vh] items-center justify-center">
            <Spinner className="h-5 w-5 text-brand-600" />
          </div>
        }>
          <Routes>
            <Route index element={<Navigate to="modules" replace />} />
            {sections.flatMap((s) => s.items).map((item) => (
              <Route key={item.path} path={item.path} element={item.element} />
            ))}
            <Route path="*" element={<Navigate to="modules" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
