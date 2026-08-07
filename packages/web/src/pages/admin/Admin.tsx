import { Suspense, lazy } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import {
  Activity, Blocks, Database, GitBranch, Globe, KeyRound, Layers, LayoutTemplate,
  ListTree, Plug, Settings2, Shield, Sliders, ToggleLeft, Users, Workflow,
} from 'lucide-react';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/utils';

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
const ImportAdmin = lazy(() => import('./ImportAdmin'));

const SECTIONS = [
  {
    group: 'Customisation',
    items: [
      { path: 'modules', label: 'Enable / Disable', icon: ToggleLeft, element: <ModuleManager /> },
      { path: 'fields', label: 'Modules & Fields', icon: Blocks, element: <ModuleBuilder /> },
      { path: 'layouts', label: 'Layout Designer', icon: LayoutTemplate, element: <LayoutDesigner /> },
      { path: 'picklists', label: 'Dropdowns', icon: ListTree, element: <PicklistManager /> },
    ],
  },
  {
    group: 'Access',
    items: [
      { path: 'users', label: 'Users', icon: Users, element: <UsersAdmin /> },
      { path: 'roles', label: 'Roles & Profiles', icon: Shield, element: <RolesProfiles /> },
      { path: 'sharing', label: 'Data Sharing', icon: KeyRound, element: <SharingAdmin /> },
    ],
  },
  {
    group: 'Automation',
    items: [
      { path: 'workflows', label: 'Workflows', icon: Workflow, element: <WorkflowAdmin /> },
      { path: 'import', label: 'Import Data', icon: Database, element: <ImportAdmin /> },
    ],
  },
  {
    group: 'Platform',
    items: [
      { path: 'integrations', label: 'Integrations', icon: Plug, element: <IntegrationsAdmin /> },
      { path: 'system', label: 'System & Audit', icon: Activity, element: <SystemAdmin /> },
    ],
  },
];

export default function AdminPage(): JSX.Element {
  return (
    <div className="flex h-full">
      <nav className="w-56 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 flex items-center gap-2 px-1">
          <Settings2 className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold">Admin</h2>
        </div>

        <div className="space-y-4">
          {SECTIONS.map((section) => (
            <div key={section.group}>
              <p className="mb-1 px-3 text-2xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">
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
            {SECTIONS.flatMap((s) => s.items).map((item) => (
              <Route key={item.path} path={item.path} element={item.element} />
            ))}
            <Route path="*" element={<Navigate to="modules" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
