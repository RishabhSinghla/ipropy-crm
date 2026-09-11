import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime, type HeaderTab } from '@ipropy/shared';
import {
  AtSign, Bell, Cake, Check, Facebook, Flame, Globe, Instagram, Linkedin, Lock, LogOut, Menu,
  MessageCircle, Moon, Search, Settings, Shield, Sparkles, Sun, Twitter, Upload, X, Youtube,
  LayoutDashboard, MapPin, Building2, Plus, ChevronDown,
} from 'lucide-react';
import { applyBrandColour, toast, useApp } from '../lib/store';
import { api, authedFileUrl, type ModuleSummary, type SearchHit } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { cn } from '../lib/utils';
import { resolveIcon } from '../lib/icons';
import { ErrorBoundary } from './ErrorBoundary';
import { Avatar, Badge, Dropdown, DropdownItem, Modal, Spinner } from './ui';
import AiAssistant from './AiAssistant';
import { PeekLink, PeekProvider } from './PeekLink';
import RecordForm from './RecordForm';

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
 * with everything else (Settings, Admin, sign-out) behind the avatar.
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

  // The admin's chosen colour dresses the whole CRM: buttons, links, chips and
  // focus rings all read the same eleven variables. Applied here — where the
  // brand row first loads — and again whenever the Brand page invalidates it.
  useEffect(() => {
    applyBrandColour(brand?.primaryColor);
  }, [brand?.primaryColor]);

  const menuModules = useMemo(
    () => modules.filter((m) => m.showInMenu && m.isEntity && m.permissions.view),
    [modules],
  );

  /*
    The header's tab order is admin property (Admin → Header Tabs). The
    arrangement names tabs by kind — module name, fixed page, or a link — and
    the same entry can rename a tab. Anything the admin has not placed is
    appended, so a module created after the arrangement still appears; the
    arrangement can only reorder and rename, never orphan.

    `arrangedCapture` says whether the Site visit tab is here because the
    admin placed it (then it renders at every width) or only from the shipped
    default (then the desktop bar drops it — see the capture branch below).
  */
  const arrangedCapture = Boolean(user?.ui?.headerTabs?.some((t) => t.kind === 'capture'));
  const headerTabs = useMemo(() => {
    const arranged = user?.ui?.headerTabs;
    // No arrangement yet: the shipped order. Dashboard first, the modules in
    // their own sequence, Site visit last.
    if (!arranged?.length) {
      return [
        { kind: 'dashboard' as const, label: undefined as string | undefined },
        ...menuModules.map((m) => ({ kind: 'module' as const, value: m.name, label: undefined as string | undefined })),
        { kind: 'capture' as const, label: undefined as string | undefined },
      ];
    }
    const placed: HeaderTab[] = arranged.map((t) => ({ ...t }));
    const used = new Set(placed.filter((t) => t.kind === 'module').map((t) => t.value));
    for (const m of menuModules) {
      if (!used.has(m.name)) placed.push({ kind: 'module' as const, value: m.name });
    }
    return placed;
  }, [user?.ui?.headerTabs, menuModules]);

  const socialPosition = user?.ui?.socialPosition ?? 'right';

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
              // A CRM-hosted logo is permission-checked, and an <img> cannot
              // send the session header — so the token rides in the query
              // string. An external https logo passes through untouched.
              <img src={authedFileUrl(brand.logoUrl)} alt="" className="h-8 w-8 shrink-0 rounded-lg object-contain" />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
                <Building2 className="h-4.5 w-4.5" />
              </div>
            )}
            <span className="hidden truncate text-base font-semibold leading-tight tracking-tight sm:block">
              {brand?.orgName ?? 'iPropy'}
            </span>
          </Link>

          {/* Social beside the brand — the admin's choice of where they sit. */}
          {socialPosition === 'brand' && <div className="hidden shrink-0 lg:block"><SocialBar /></div>}

          {/* Primary tabs. The admin's arrangement decides the order, names and
              extras (Admin → Header Tabs); modules still appear here on their
              own, and a disabled one disappears. */}
          <nav aria-label="Main" className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:flex">
            {headerTabs.map((t, i) => {
              const key = `${t.kind}-${t.value ?? ''}-${i}`;
              if (t.kind === 'dashboard') {
                return <TabItem key={key} to="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />} label={t.label ?? 'Dashboard'} />;
              }
              if (t.kind === 'capture') {
                /*
                  Phone-only by default. At a desk the capture form is two clicks
                  from Properties ("New Property" → "Capture on site"), so the
                  tab there duplicated a path and read as a fifth destination;
                  on a phone it *is* the destination — one tap from the bottom
                  bar, standing at the gate — so the drawer and bottom tabs keep
                  it unconditionally. An admin who explicitly places the tab in
                  Admin → Header Tabs overrides this and it shows at every width.
                */
                if (!arrangedCapture) return null;
                return <TabItem key={key} to="/capture" icon={<MapPin className="h-4 w-4" />} label={t.label ?? 'Site visit'} />;
              }
              if (t.kind === 'link') {
                return (
                  <a
                    key={key}
                    href={t.value}
                    target={t.value?.startsWith('http') ? '_blank' : undefined}
                    rel="noreferrer"
                    className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                  >
                    <Globe className="h-4 w-4" />
                    <span className="whitespace-nowrap">{t.label ?? t.value}</span>
                  </a>
                );
              }
              const m = menuModules.find((x) => x.name === t.value);
              // A module the admin hid from the menu, or one this user cannot
              // open, is not rendered — the arrangement merely names what
              // would appear anyway.
              if (!m) return null;
              return (
                <TabItem
                  key={key}
                  to={`/${m.name}`}
                  icon={<ModuleIcon name={m.icon} />}
                  label={t.label ?? m.label}
                  badge={unseenCounts?.[m.name]}
                />
              );
            })}
          </nav>

          {/* Search sits beside the tabs, and shrinks before the tabs do. */}
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 lg:flex-none">
            <NewRecordButton modules={menuModules} />
            <GlobalSearch />

            <div className="flex shrink-0 items-center gap-1">
              {socialPosition === 'right' && <SocialBar />}
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

        {/* The bottom tab bar is fixed, so without this the last 64px of every
            page — a form's Save button included — sits behind it. */}
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto pb-16 lg:pb-0">
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

/**
 * "New" wherever you are.
 *
 * Adding a contact used to mean going to Contacts first, and adding a property
 * meant going to Properties — one tab-click of ceremony before the form that
 * does the work, fifty times a day. This is the same Create the list page
 * offers, hoisted into the shell beside the search box, so a number somebody
 * just read out on the phone can be typed from the dashboard, from a record,
 * from anywhere.
 *
 * The menu is built from the modules themselves, filtered by the caller's own
 * create permission — nothing here names Contacts or Properties, so a module an
 * admin adds later appears without a code change, and one a profile cannot
 * create into never does.
 */
function NewRecordButton({ modules }: { modules: ModuleSummary[] }): JSX.Element | null {
  const creatable = modules.filter((m) => m.permissions.create);
  const [creating, setCreating] = useState<ModuleSummary | null>(null);
  const queryClient = useQueryClient();
  const user = useApp((state) => state.user);
  const { data: createMeta, isLoading } = useQuery({
    queryKey: ['module', creating?.name],
    queryFn: () => api.module(creating!.name),
    enabled: Boolean(creating),
  });
  if (!creatable.length) return null;

  const createModal = creating ? (
    <Modal open onClose={() => setCreating(null)} title={`New ${creating.singularLabel}`} size="lg">
      {isLoading || !createMeta ? (
        <div className="flex min-h-40 items-center justify-center"><Spinner className="h-5 w-5" /></div>
      ) : (
        <RecordForm
          module={createMeta}
          mode="quick_create"
          initialValues={user ? { owner_id: user.id } : undefined}
          onSaved={(record) => {
            setCreating(null);
            toast.success(`${creating.singularLabel} created`, record.label);
            void queryClient.invalidateQueries({ queryKey: ['records', creating.name] });
          }}
          onCancel={() => setCreating(null)}
        />
      )}
    </Modal>
  ) : null;

  // One creatable module is a button, not a menu: a dropdown with a single
  // entry is a click spent on confirming there was no choice to make.
  if (creatable.length === 1) {
    const only = creatable[0]!;
    return (
      <>
        <button
          type="button"
          onClick={() => setCreating(only)}
          className="btn-primary btn-sm shrink-0 gap-1"
          title={`New ${only.singularLabel}`}
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">New</span>
        </button>
        {createModal}
      </>
    );
  }

  return (
    <>
    <Dropdown
      align="right"
      trigger={(
        /* Named "New record", not "Create…". The word is hidden below `sm`, so
           the accessible name falls back to this — and "Create a new record"
           collided with every form's own Create button in the mobile suite,
           which is the kind of failure a name chosen for prose causes. */
        <button className="btn-primary btn-sm shrink-0 gap-1" title="New record" aria-label="New record" data-testid="global-create">
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">New</span>
          <ChevronDown className="h-3 w-3 opacity-80" />
        </button>
      )}
    >
      {(close) => (
        <>
          {creatable.map((m) => (
            <DropdownItem
              key={m.name}
              icon={<ModuleIcon name={m.icon} className="h-3.5 w-3.5" />}
              onClick={() => { close(); setCreating(m); }}
            >
              New {m.singularLabel}
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
    {createModal}
    </>
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
 * Settings, Admin panel and sign-out live here — "things about you
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
            {user?.roleName && (
              <Badge className="mt-1.5">{user.roleName}</Badge>
            )}
          </div>
          {/* Admin panel, then Settings, then Log out — the owner's order.
              Admin is where he actually goes from here, and sign-out sits last
              so a mis-click on the way to it lands on a page, not a logout. */}
          {user?.isAdmin && (
            <Link to="/admin" onClick={close}>
              <DropdownItem icon={<Shield className="h-3.5 w-3.5" />}>Admin panel</DropdownItem>
            </Link>
          )}
          <Link to="/settings" onClick={close}>
            <DropdownItem icon={<Settings className="h-3.5 w-3.5" />}>Settings</DropdownItem>
          </Link>
          <DropdownItem icon={<LogOut className="h-3.5 w-3.5" />} danger onClick={() => void logout()}>
            Log out
          </DropdownItem>
        </>
      )}
    </Dropdown>
  );
}

/**
 * The drawer behind the hamburger on a phone. Everything is reachable even
 * though the bottom bar shows only the five main destinations — an admin
 * hiding mid-work needs Settings without a detour.
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

/** One line per kind, so the panel can lead with a picture rather than text. */
function NotificationIcon({ kind, link }: { kind: string; link: string | null }): JSX.Element {
  const c = 'h-3.5 w-3.5';
  const to = (icon: JSX.Element, tone: string): JSX.Element => (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone}`}>{icon}</span>
  );
  if (link?.startsWith('/capture')) return to(<MapPin className={c} />, 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400');
  if (kind === 'ai') return to(<Sparkles className={c} />, 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400');
  if (kind === 'mention') return to(<AtSign className={c} />, 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400');
  if (kind === 'import') return to(<Upload className={c} />, 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400');
  if (kind === 'escalation') return to(<Flame className={c} />, 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400');
  if (kind === 'birthday') return to(<Cake className={c} />, 'bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-400');
  return to(<Bell className={c} />, 'bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-400');
}

function NotificationBell(): JSX.Element {
  const { data, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications(),
    refetchInterval: 40_000,
  });
  const navigate = useNavigate();
  const unread = data?.unreadCount ?? 0;
  const notes = ((data?.notifications ?? []) as {
    id: string; title: string; body: string | null; link: string | null;
    is_read: boolean; kind: string; created_at: string;
  }[]);

  return (
    <Dropdown
      trigger={
        <button
          className="btn-ghost relative rounded-full p-2 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
          title="Notifications"
          aria-label={unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}
        >
          <Bell className={cn('h-4 w-4 transition-transform', unread > 0 && 'text-brand-600 dark:text-brand-400')} />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] animate-pulse-success items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white ring-2 ring-white dark:ring-slate-900">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      }
      className="w-[min(24rem,calc(100vw-1.5rem))] py-0"
    >
      {(close) => (
        <div className="max-h-[min(28rem,70vh)] overflow-y-auto">
          {/* The header stays put while the list scrolls — unread state and
              actions belong to the whole panel, not to wherever you scrolled. */}
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-slate-100 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
            <div>
              <p className="text-sm font-semibold">Notifications</p>
              <p className="text-2xs text-muted">
                {unread > 0 ? `${unread} unread` : 'You are all caught up'}
              </p>
            </div>
            {unread > 0 && (
              <button
                className="shrink-0 rounded-full px-2.5 py-1 text-2xs font-medium text-brand-700 transition-colors hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-950/60"
                onClick={() => { void api.markNotificationsRead().then(() => refetch()); }}
              >
                Mark all read
              </button>
            )}
          </div>

          {notes.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
                <Check className="h-5 w-5 text-slate-400" />
              </span>
              <p className="text-sm font-medium">Nothing new</p>
              <p className="text-2xs text-muted">Follow-ups, mentions and matches land here.</p>
            </div>
          )}

          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => {
                    void api.markNotificationsRead([n.id]).then(() => refetch());
                    if (n.link) navigate(n.link);
                    close();
                  }}
                  className={cn(
                    'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/70',
                    !n.is_read && 'bg-brand-50/60 dark:bg-brand-950/30',
                  )}
                >
                  <NotificationIcon kind={n.kind} link={n.link} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('flex items-baseline gap-2', !n.is_read && 'font-medium')}>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-800 dark:text-slate-200">{n.title}</span>
                      {/* A dot, not a colour: the unread state survives every
                          theme and does not fight the body copy. */}
                      {!n.is_read && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand-500" />}
                    </span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-2xs text-muted">{n.body}</span>}
                    <span className="mt-1 block text-2xs text-muted">{relativeTime(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
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
