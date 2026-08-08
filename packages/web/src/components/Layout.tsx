import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell, Building2, ChevronLeft, LogOut, Menu, Moon, Search, Settings, Shield, Sparkles, Sun, X,
} from 'lucide-react';
import { useApp } from '../lib/store';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { cn, groupModules } from '../lib/utils';
import { resolveIcon } from '../lib/icons';
import { ErrorBoundary } from './ErrorBoundary';
import { Avatar, Badge, Dropdown, DropdownItem, Spinner } from './ui';
import AiAssistant from './AiAssistant';

/** Resolve a lucide icon by its kebab-case metadata name (see lib/icons.ts for why this is a registry, not a namespace lookup). */
export function ModuleIcon({ name, className }: { name: string; className?: string }): JSX.Element {
  const Icon = resolveIcon(name);
  return <Icon className={className ?? 'h-4 w-4'} />;
}

export default function Layout(): JSX.Element {
  const { user, modules, sidebarCollapsed, toggleSidebar, theme, setTheme, logout, aiAvailable } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const location = useLocation();

  // One socket for the whole session: server-side changes (workflow tasks, AI
  // scoring, another user's edit) invalidate the matching queries live.
  useRealtime(Boolean(user));

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // Records that arrived while this user was away, per module. Polled rather
  // than pushed because it also has to be right after a colleague reassigns
  // something, which produces no event on this session's socket.
  const { data: unseenCounts } = useQuery({
    queryKey: ['unseen-counts'],
    queryFn: () => api.unseenCounts(),
    enabled: Boolean(user),
    refetchInterval: 60_000,
  });

  const grouped = useMemo(
    () => groupModules(modules.filter((m) => m.showInMenu && m.isEntity && m.permissions.view)),
    [modules],
  );

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950">
      {/* Visually hidden until focused — the first Tab stop on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to main content
      </a>

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-slate-200 bg-white transition-all dark:border-slate-800 dark:bg-slate-900 lg:static',
          sidebarCollapsed ? 'w-[4.25rem]' : 'w-60',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-800">
          <Link to="/dashboard" className="flex items-center gap-2 overflow-hidden">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
              <Building2 className="h-4.5 w-4.5" />
            </div>
            {!sidebarCollapsed && (
              <span className="truncate text-base font-semibold tracking-tight">iPropy</span>
            )}
          </Link>
          <button
            onClick={() => setMobileOpen(false)}
            className="btn-ghost ml-auto p-1.5 lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
          <div className="space-y-0.5">
            <NavItem to="/dashboard" icon="layout-dashboard" label="Dashboard" collapsed={sidebarCollapsed} />
            <NavItem to="/inbox" icon="message-circle" label="Inbox" collapsed={sidebarCollapsed} badge={<InboxBadge />} />
            <NavItem to="/calls" icon="phone" label="Calls" collapsed={sidebarCollapsed} />
          </div>

          {grouped.map(([group, list]) => (
            <div key={group}>
              {!sidebarCollapsed && (
                <p className="mb-1 px-3 text-2xs font-semibold uppercase tracking-wider text-muted">
                  {group}
                </p>
              )}
              <div className="space-y-0.5">
                {list.map((m) => (
                  <NavItem
                    key={m.name}
                    to={`/${m.name}`}
                    icon={m.icon}
                    label={m.label}
                    collapsed={sidebarCollapsed}
                    color={m.color}
                    badge={unseenCounts?.[m.name]
                      ? <UnseenBadge count={unseenCounts[m.name]} />
                      : undefined}
                  />
                ))}
              </div>
            </div>
          ))}

          <div>
            {!sidebarCollapsed && (
              <p className="mb-1 px-3 text-2xs font-semibold uppercase tracking-wider text-muted">
                Tools
              </p>
            )}
            <div className="space-y-0.5">
              <NavItem to="/inventory" icon="layout-grid" label="Inventory Board" collapsed={sidebarCollapsed} />
              <NavItem to="/reports" icon="bar-chart-3" label="Reports" collapsed={sidebarCollapsed} />
            </div>
          </div>
        </nav>

        <div className="shrink-0 border-t border-slate-200 p-2 dark:border-slate-800">
          {user?.isAdmin && (
            <NavItem to="/admin" icon="shield" label="Admin" collapsed={sidebarCollapsed} />
          )}
          <button
            onClick={toggleSidebar}
            className="nav-item hidden w-full lg:flex"
            title={sidebarCollapsed ? 'Expand' : 'Collapse'}
          >
            <ChevronLeft className={cn('h-4 w-4 transition-transform', sidebarCollapsed && 'rotate-180')} />
            {!sidebarCollapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-900 sm:px-4">
          <button
            onClick={() => setMobileOpen(true)}
            className="btn-ghost p-2 lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>

          <GlobalSearch />

          <div className="ml-auto flex items-center gap-1">
            {aiAvailable !== undefined && (
              <button
                onClick={() => setAiOpen(true)}
                className="btn-ghost gap-1.5 px-2.5"
                title="Ask iPropy AI"
              >
                <Sparkles className="h-4 w-4 text-brand-500" />
                <span className="hidden text-xs font-medium sm:inline">Ask AI</span>
              </button>
            )}

            <NotificationBell />

            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="btn-ghost p-2"
              title="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            <Dropdown
              trigger={
                <button className="ml-1 flex items-center gap-2 rounded-lg p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Avatar name={user?.fullName ?? '?'} src={user?.avatarUrl} size={28} />
                </button>
              }
            >
              {(close) => (
                <>
                  <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                    <p className="truncate text-sm font-medium">{user?.fullName}</p>
                    <p className="truncate text-xs text-muted">{user?.email}</p>
                    {user?.profileName && (
                      <Badge className="mt-1.5">{user.profileName}</Badge>
                    )}
                  </div>
                  <Link to="/settings" onClick={close}>
                    <DropdownItem icon={<Settings className="h-3.5 w-3.5" />}>Settings</DropdownItem>
                  </Link>
                  {user?.isAdmin && (
                    <Link to="/admin" onClick={close}>
                      <DropdownItem icon={<Shield className="h-3.5 w-3.5" />}>Admin panel</DropdownItem>
                    </Link>
                  )}
                  <DropdownItem icon={<LogOut className="h-3.5 w-3.5" />} danger onClick={() => void logout()}>
                    Sign out
                  </DropdownItem>
                </>
              )}
            </Dropdown>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
          {/* Per-page net. Keyed on the path so a crashed page clears itself
              when the user navigates away — without the key the boundary stays
              latched and every subsequent route renders the error screen. The
              sidebar and header live outside it and stay usable throughout. */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <AiAssistant open={aiOpen} onClose={() => setAiOpen(false)} />
    </div>
  );
}

function NavItem({
  to, icon, label, collapsed, badge, color,
}: {
  to: string; icon: string; label: string; collapsed: boolean;
  badge?: JSX.Element; color?: string;
}): JSX.Element {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn('nav-item', isActive && 'nav-item-active', collapsed && 'justify-center px-2')}
      title={collapsed ? label : undefined}
    >
      <span style={color && !collapsed ? { color } : undefined} className="shrink-0">
        <ModuleIcon name={icon} />
      </span>
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
      {!collapsed && badge}
    </NavLink>
  );
}

/** Count of records in a module this user has never opened. */
function UnseenBadge({ count }: { count: number }): JSX.Element {
  return (
    <span
      className="rounded-full bg-brand-600 px-1.5 py-0.5 text-2xs font-semibold text-white"
      title={`${count} new — not opened yet`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function InboxBadge(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['inbox-unread'],
    queryFn: () => api.conversations({ status: 'open', limit: 100 }),
    refetchInterval: 45_000,
  });
  const unread = (data ?? []).reduce((n, c) => n + Number((c as { unread_count?: number }).unread_count ?? 0), 0);
  if (!unread) return null;
  return (
    <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-2xs font-semibold text-white">
      {unread > 99 ? '99+' : unread}
    </span>
  );
}

function NotificationBell(): JSX.Element {
  const { data, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications(),
    refetchInterval: 40_000,
  });
  const navigate = useNavigate();
  const unread = data?.unreadCount ?? 0;

  return (
    <Dropdown
      trigger={
        <button className="btn-ghost relative p-2" title="Notifications">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      }
      className="w-80"
    >
      {(close) => (
        <>
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <p className="text-sm font-medium">Notifications</p>
            {unread > 0 && (
              <button
                className="text-xs text-brand-600 hover:underline"
                onClick={() => { void api.markNotificationsRead().then(() => refetch()); }}
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {(data?.notifications ?? []).length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-muted">Nothing new</p>
            )}
            {(data?.notifications ?? []).map((n) => {
              const note = n as { id: string; title: string; body: string | null; link: string | null; is_read: boolean; created_at: string };
              return (
                <button
                  key={note.id}
                  onClick={() => {
                    void api.markNotificationsRead([note.id]).then(() => refetch());
                    if (note.link) navigate(note.link);
                    close();
                  }}
                  className={cn(
                    'block w-full border-b border-slate-50 px-3 py-2 text-left last:border-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800',
                    !note.is_read && 'bg-brand-50/50 dark:bg-brand-950/30',
                  )}
                >
                  <p className="text-xs font-medium text-slate-800 dark:text-slate-200">{note.title}</p>
                  {note.body && <p className="mt-0.5 line-clamp-2 text-2xs text-muted">{note.body}</p>}
                  <p className="mt-1 text-2xs text-muted">
                    {new Date(note.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </button>
              );
            })}
          </div>
        </>
      )}
    </Dropdown>
  );
}

function GlobalSearch(): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<{ id: string; module: string; moduleLabel: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void api.search(query)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="relative max-w-md flex-1" ref={ref}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        className="input py-1.5 pl-8 pr-12"
        placeholder="Search everything…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => setQuery(e.target.value)}
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-muted dark:border-slate-700 sm:block">
        ⌘K
      </kbd>

      {open && query.trim().length >= 2 && (
        <div className="absolute z-40 mt-1 max-h-96 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-float dark:border-slate-700 dark:bg-slate-900">
          {loading && <div className="flex justify-center py-6"><Spinner className="text-slate-400" /></div>}
          {!loading && results.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted">No matches for “{query}”</p>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => { navigate(`/${r.module}/${r.id}`); setOpen(false); setQuery(''); }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <span className="truncate text-sm">{r.label}</span>
              <Badge className="shrink-0">{r.moduleLabel}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
