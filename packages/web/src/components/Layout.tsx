import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell, Facebook, Globe, Instagram, Linkedin, Lock, LogOut, Menu, MessageCircle, Moon, Search,
  Settings, Shield, Sparkles, Sun, Twitter, X, Youtube, BarChart3, LayoutDashboard, MapPin, Building2,
} from 'lucide-react';
import { useApp } from '../lib/store';
import { api, type SearchHit } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { cn } from '../lib/utils';
import { resolveIcon } from '../lib/icons';
import { ErrorBoundary } from './ErrorBoundary';
import { Avatar, Badge, Dropdown, DropdownItem, Spinner } from './ui';
import AiAssistant from './AiAssistant';
import { PeekLink, PeekProvider } from './PeekLink';

/** Resolve a lucide icon by its kebab-case metadata name (see lib/icons.ts for why this is a registry, not a namespace lookup). */
export function ModuleIcon({ name, className }: { name: string; className?: string }): JSX.Element {
  const Icon = resolveIcon(name);
  return <Icon className={className ?? 'h-4 w-4'} />;
}

/**
 * The shell: a single top bar instead of the old sidebar.
 *
 * The owner asked for the CRM to open onto the work itself — Dashboard,
 * Contacts (leads), Properties, Site visit — as tabs beside the search box,
 * with everything else (Reports, Settings, Admin, sign-out) behind the avatar.
 * The sidebar spent 13rem of width and a second click on navigation that a
 * tab performs in one, and its Inbox/Calls/Outreach entries were whole pages
 * this business never opened; the messaging a rep actually does is on each
 * record. On a phone the same five destinations become a bottom tab bar,
 * WhatsApp-style, because a thumb cannot reach the top of a tall screen.
 */
export default function Layout(): JSX.Element {
  const { user, modules, theme, setTheme, aiAvailable } = useApp();
  const [aiOpen, setAiOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // One socket for the whole session: server-side changes (workflow tasks, AI
  // scoring, another user's edit) invalidate the matching queries live.
  useRealtime(Boolean(user));

  const { data: unseenCounts } = useQuery({
    queryKey: ['unseen-counts'],
    queryFn: () => api.unseenCounts(),
    enabled: Boolean(user),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  const { data: brand } = useQuery({
    queryKey: ['brand'],
    queryFn: () => api.brand(),
    enabled: Boolean(user),
    staleTime: 10 * 60_000,
  });

  const menuModules = useMemo(
    () => modules.filter((m) => m.showInMenu && m.isEntity && m.permissions.view),
    [modules],
  );

  return (
    <PeekProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
        {/* Visually hidden until focused — the first Tab stop on every page. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
        >
          Skip to main content
        </a>

        {/* Top bar: brand and primary navigation on the left, search and
            actions on the right. One row, every width — the old sidebar spent
            its whole height saying what a 12px tab now says. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-900 sm:gap-3 sm:px-4">
          <button
            onClick={() => setDrawerOpen(true)}
            className="btn-ghost p-2 lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>

          <Link to="/dashboard" className="flex shrink-0 items-center gap-2 overflow-hidden" aria-label={brand?.orgName ?? 'iPropy'}>
            {brand?.logoUrl ? (
              <img src={brand.logoUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg object-contain" />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
                <Building2 className="h-4.5 w-4.5" />
              </div>
            )}
            <span className="hidden truncate text-base font-semibold leading-tight tracking-tight sm:block">
              {brand?.orgName ?? 'iPropy'}
            </span>
          </Link>

          {/* Primary tabs. The module metadata decides what exists — a custom
              module appears here on its own, and a disabled one disappears. */}
          <nav aria-label="Main" className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:flex">
            <TabItem to="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />} label="Dashboard" />
            {menuModules.map((m) => (
              <TabItem
                key={m.name}
                to={`/${m.name}`}
                icon={<ModuleIcon name={m.icon} />}
                label={m.label}
                badge={unseenCounts?.[m.name]}
              />
            ))}
            <TabItem to="/capture" icon={<MapPin className="h-4 w-4" />} label="Site visit" />
          </nav>

          {/* Search sits beside the tabs, and shrinks before the tabs do. */}
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 lg:flex-none">
            <GlobalSearch />

            <div className="flex shrink-0 items-center gap-1">
              <SocialBar />
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

              <UserMenu />
            </div>
          </div>
        </header>

        {/* Mobile drawer: on a phone the tabs move to the bottom bar; the
            drawer keeps the full navigation for anything that is not on it. */}
        <MobileNav
          modules={menuModules}
          unseenCounts={unseenCounts}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />

        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
          {/* Per-page net. Keyed on the path so a crashed page clears itself
              when the user navigates away — without the key the boundary stays
              latched and every subsequent route renders the error screen. The
              header lives outside it and stays usable throughout. */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>

        <AiAssistant open={aiOpen} onClose={() => setAiOpen(false)} />
      </div>
    </PeekProvider>
  );
}

function TabItem({
  to, icon, label, badge,
}: { to: string; icon: JSX.Element; label: string; badge?: number }): JSX.Element {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn(
        'flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
        isActive
          ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200',
      )}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
      {badge ? <UnseenBadge count={badge} module={to.slice(1)} /> : undefined}
    </NavLink>
  );
}

function UnseenBadge({ count, module }: { count: number; module: string }): JSX.Element {
  return (
    <span
      className="rounded-full bg-brand-600 px-1.5 py-0.5 text-2xs font-semibold text-white"
      title={module === 'leads'
        ? `${count} lead${count === 1 ? '' : 's'} still in New status`
        : `${count} new — not opened yet`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * Reports, Settings, Admin panel and sign-out live here — "things about you
 * and your workspace", as the owner put it — not on the navigation surface a
 * rep crosses fifty times a day.
 */
function UserMenu(): JSX.Element {
  const { user, logout } = useApp();
  return (
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
          <Link to="/reports" onClick={close}>
            <DropdownItem icon={<BarChart3 className="h-3.5 w-3.5" />}>Reports</DropdownItem>
          </Link>
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
  );
}

/**
 * The drawer behind the hamburger on a phone. Everything is reachable even
 * though the bottom bar shows only the five main destinations — an admin
 * hiding mid-work needs Reports and Settings without a detour.
 */
function MobileNav({
  modules, unseenCounts, open, onClose,
}: {
  modules: { name: string; label: string; icon: string }[];
  unseenCounts?: Record<string, number>;
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const location = useLocation();

  // Navigating must dismiss the drawer: leaving it open covers the page the
  // user just asked for.
  useEffect(() => { onClose(); }, [location.pathname]);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden" onClick={onClose} />
      )}

      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 ease-out dark:border-slate-800 dark:bg-slate-900 lg:hidden',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 dark:border-slate-800">
          <p className="text-sm font-semibold">Menu</p>
          <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
          <div className="space-y-0.5">
            <DrawerLink to="/dashboard" icon="layout-dashboard" label="Dashboard" />
            {modules.map((m) => (
              <DrawerLink
                key={m.name}
                to={`/${m.name}`}
                icon={m.icon}
                label={m.label}
                badge={unseenCounts?.[m.name]}
              />
            ))}
            <DrawerLink to="/capture" icon="map-pin" label="Site visit" />
          </div>
          <div className="space-y-0.5">
            <p className="mb-1 px-3 text-2xs font-semibold uppercase tracking-wider text-muted">Tools</p>
            <DrawerLink to="/reports" icon="bar-chart-3" label="Reports" />
            <DrawerLink to="/settings" icon="settings" label="Settings" />
          </div>
        </nav>
      </div>

      {/* The bottom tab bar a thumb reaches: the five destinations this desk
          lives on, WhatsApp-style. The active tab is the brand colour and the
          rest are quiet, so the eye lands without reading. */}
      <BottomTabs modules={modules} unseenCounts={unseenCounts} />
    </>
  );
}

function DrawerLink({
  to, icon, label, badge,
}: { to: string; icon: string; label: string; badge?: number }): JSX.Element {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn('nav-item', isActive && 'nav-item-active')}
      aria-label={badge ? `${label} — ${badge} new` : label}
    >
      <span className="shrink-0"><ModuleIcon name={icon} /></span>
      <span className="flex-1 truncate">{label}</span>
      {badge ? <UnseenBadge count={badge} module={to.slice(1)} /> : undefined}
    </NavLink>
  );
}

function BottomTabs({
  modules, unseenCounts,
}: {
  modules: { name: string; label: string; icon: string }[];
  unseenCounts?: Record<string, number>;
}): JSX.Element {
  const leads = modules.find((m) => m.name === 'leads');
  const properties = modules.find((m) => m.name === 'properties');
  const tabs = [
    { to: '/dashboard', icon: 'layout-dashboard', label: 'Dashboard' },
    leads && { to: `/${leads.name}`, icon: leads.icon, label: leads.label, badge: unseenCounts?.[leads.name] },
    properties && { to: `/${properties.name}`, icon: properties.icon, label: properties.label, badge: unseenCounts?.[properties.name] },
    { to: '/capture', icon: 'map-pin', label: 'Site visit' },
    { to: '/settings', icon: 'settings', label: 'You' },
  ].filter(Boolean) as { to: string; icon: string; label: string; badge?: number }[];

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex shrink-0 items-stretch justify-around border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden dark:border-slate-800 dark:bg-slate-900"
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) => cn(
            'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-2xs font-medium transition-colors',
            isActive ? 'text-brand-600 dark:text-brand-400' : 'text-slate-500 dark:text-slate-400',
          )}
        >
          <span className="relative">
            <ModuleIcon name={tab.icon} className="h-5 w-5" />
            {tab.badge ? <span className="absolute -right-1.5 -top-1 h-1.5 w-1.5 rounded-full bg-brand-600" /> : undefined}
          </span>
          <span className="w-full truncate text-center">{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * One-click links to the company's own social accounts.
 *
 * Admin-editable (Admin → Brand & Social), so a wrong or dead handle is a
 * text field to fix, not a deploy.
 */
function SocialBar(): JSX.Element | null {
  const { data: brand } = useQuery({
    queryKey: ['brand'],
    queryFn: () => api.brand(),
    staleTime: 10 * 60_000,
  });

  const links = brand?.socialLinks ?? [];
  if (!links.length) return null;

  return (
    <div className="mr-1 hidden items-center gap-0.5 border-r border-slate-200 pr-2 md:flex dark:border-slate-700">
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer noopener"
          title={`${link.label} — opens in a new tab`}
          aria-label={link.label}
          style={{ color: SOCIAL_COLOURS[link.platform] ?? undefined }}
          className={cn(
            'rounded-md p-1.5 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800',
            !SOCIAL_COLOURS[link.platform] && 'text-slate-400 hover:text-brand-600 dark:hover:text-brand-400',
          )}
        >
          <SocialIcon platform={link.platform} />
        </a>
      ))}
    </div>
  );
}

/**
 * Each platform's own brand colour, so the row is scannable by hue rather
 * than by squinting at five near-identical grey glyphs.
 *
 * Two are not the official brand value on purpose. X's brand colour is pure
 * black, which disappears against the dark theme, and Instagram's is a gradient
 * a single `color` cannot express — so those use the nearest legible solid.
 */
const SOCIAL_COLOURS: Record<string, string> = {
  instagram: '#E4405F', // the magenta the gradient resolves to at a small size
  facebook: '#1877F2',
  x: '#71767B', // brand is #000; that is invisible on dark, so X's own grey
  twitter: '#1DA1F2',
  linkedin: '#0A66C2',
  youtube: '#FF0000',
  whatsapp: '#25D366',
};

function SocialIcon({ platform }: { platform: string }): JSX.Element {
  const className = 'h-4 w-4';
  switch (platform) {
    case 'instagram': return <Instagram className={className} />;
    case 'facebook': return <Facebook className={className} />;
    case 'x':
    case 'twitter': return <Twitter className={className} />;
    case 'linkedin': return <Linkedin className={className} />;
    case 'youtube': return <Youtube className={className} />;
    case 'whatsapp': return <MessageCircle className={className} />;
    default: return <Globe className={className} />;
  }
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
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
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
    <div className="relative ml-auto w-full max-w-md lg:ml-2 lg:w-auto lg:max-w-xs xl:max-w-sm" ref={ref}>
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
          {results.map((r) => (r.restricted ? (
            /*
              Not a link, because there is nothing to open — this record is
              outside what this user may see, and the row exists to answer one
              question: is this number already ours, and whose? Anything more
              would be a way around the sharing rules rather than a courtesy
              inside them.
            */
            <div
              key={r.id}
              className="flex items-start gap-2 border-l-2 border-amber-400 bg-amber-50/60 px-3 py-2 dark:bg-amber-950/30"
            >
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.label}</p>
                <p className="text-xs text-muted">
                  Already in {r.moduleLabel}, assigned to{' '}
                  <strong className="font-medium text-slate-700 dark:text-slate-200">
                    {r.ownerName ?? 'nobody yet'}
                  </strong>
                  . Not shared with you.
                </p>
              </div>
            </div>
          ) : (
            <PeekLink
              key={r.id}
              module={r.module}
              id={r.id}
              label={r.label}
              // A modified click opens a background tab and the browser leaves
              // this page alone — so clearing the box would throw away the
              // results somebody is deliberately working through one at a time.
              onNavigate={() => { setOpen(false); setQuery(''); }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50 [-webkit-touch-callout:none] dark:hover:bg-slate-800"
            >
              <span className="truncate text-sm">{r.label}</span>
              <Badge className="shrink-0">{r.moduleLabel}</Badge>
            </PeekLink>
          )))}
        </div>
      )}
    </div>
  );
}
