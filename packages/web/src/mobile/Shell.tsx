/**
 * The app, as against the website.
 *
 * Mounted instead of the web shell when the bundle is running inside the
 * installed app. A phone browser keeps the responsive web layout exactly as it
 * was — this is not a breakpoint, it is a different product surface, and
 * treating it as a breakpoint is how the e2e suite's phone-width specs would
 * have started failing for reasons nobody could see.
 *
 * Two decisions worth stating, because both are departures:
 *
 * The app opens on Contacts, not a dashboard. A messaging app opens on
 * messages. The dashboard is a real thing somebody configured and is still
 * here — it is a row in You, and `/dashboard` still resolves — but it is not
 * what a rep wants two seconds after unlocking their phone.
 *
 * The tabs are the modules, read from metadata. Not a fixed list: add a module
 * in the admin panel and it becomes a tab, rename it and the tab renames. A
 * hardcoded tab bar would be the one part of this CRM that needed a Play Store
 * release to rename a thing.
 */
import { type JSX, lazy, Suspense } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from '../lib/store';
import { Spinner } from '../components/ui';
/*
  `resolveIcon`, not Layout's `ModuleIcon`. They render the same thing, but
  importing anything from Layout drags socket.io, the realtime listener and the
  AI assistant into this chunk — the whole reason the web shell is lazy.
*/
import { resolveIcon } from '../lib/icons';
import { Camera, CircleUser } from 'lucide-react';
import { cn } from '../lib/utils';
import { tap } from '../lib/nativeActions';
import { useBottomBarHeight } from './useBottomBarHeight';

import MobileList from './List';
import MobileRecord from './Record';
import MobileCompose from './Compose';
import MobileYou from './You';

// At a desk in spirit, so they load only if somebody asks for them.
const SiteCapture = lazy(() => import('../pages/SiteCapture'));
const Dashboard = lazy(() => import('../pages/Dashboard'));
const Admin = lazy(() => import('../pages/admin/Admin'));

function Loading(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-[var(--app-bg)]">
      <Spinner className="h-6 w-6 text-brand-600" />
    </div>
  );
}

export default function MobileShell(): JSX.Element {
  const modules = useApp((s) => s.modules);
  const home = modules[0]?.name ?? 'leads';

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]">
      <main className="min-h-0 flex-1">
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route index element={<Navigate to={`/${home}`} replace />} />
            <Route path="/settings" element={<MobileYou />} />
            <Route path="/capture" element={<SiteCapture />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/dashboard/:id" element={<Dashboard />} />
            <Route path="/admin/*" element={<Admin />} />

            {/* Generic, like the web's. Every module, seeded or custom. */}
            <Route path="/:module" element={<MobileList />} />
            <Route path="/:module/new" element={<MobileCompose />} />
            <Route path="/:module/:id" element={<MobileRecord />} />

            <Route path="*" element={<Navigate to={`/${home}`} replace />} />
          </Routes>
        </Suspense>
      </main>

      <TabBar />
    </div>
  );
}

function ModuleTabIcon({ name }: { name: string }): JSX.Element {
  const Icon = resolveIcon(name);
  return <Icon className="h-6 w-6" />;
}

function TabBar(): JSX.Element | null {
  const modules = useApp((s) => s.modules);
  const location = useLocation();
  const ref = useBottomBarHeight();

  /*
    Hidden on any screen that is not a destination.

    A record, a new-record form and the site-visit screen are all pushed on top
    of a tab; keeping the bar visible there invites somebody to tap away from a
    half-filled form, and every phone app hides it for exactly that reason.
  */
  const segments = location.pathname.split('/').filter(Boolean);
  const isDestination = segments.length <= 1;
  if (!isDestination) return null;

  /*
    The modules, then the two screens that belong to the app rather than to any
    module. Site visit is one of them and has to be a tab: it is the thing this
    team does standing up, and burying it behind a menu is how it stops being
    used. It is a route in its own right on the web too, for the same reason.
  */
  /*
    Two kinds of tab, and they get their icons from different places.

    A module's icon is whatever an admin picked in the module editor, so it
    comes from the same registry that picker offers. The last two are not
    modules — they are screens the app has — and their icons are not in that
    registry and must not be added to it, or they would start appearing as
    choices for a module. Passing the component directly keeps the registry
    meaning exactly what it says.
  */
  const tabs: { to: string; label: string; icon: JSX.Element }[] = [
    ...modules.map((m) => ({
      to: `/${m.name}`,
      label: m.label,
      icon: <ModuleTabIcon name={m.icon} />,
    })),
    { to: '/capture', label: 'Site visit', icon: <Camera className="h-6 w-6" /> },
    { to: '/settings', label: 'You', icon: <CircleUser className="h-6 w-6" /> },
  ];

  return (
    <nav
      ref={ref}
      aria-label="Primary"
      className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex items-stretch">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            onClick={() => void tap()}
            className={({ isActive }) => cn(
              'flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 pb-1.5 pt-2 text-[10px] font-medium',
              isActive ? 'text-brand-600 dark:text-brand-400' : 'text-slate-500 dark:text-slate-400',
            )}
          >
            {tab.icon}
            <span className="w-full truncate text-center">{tab.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
