import { type JSX, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  AtSign, Bell, Cake, Check, Flame, Lock, LogOut, Menu, Moon, Search, Settings, Shield, Sparkles, Sun, Upload, X, MessagesSquare, MapPin, Plus, ChevronDown,
} from 'lucide-react';
import { applyBrandColour, toast, useApp } from '../lib/store';
import { api, authedFileUrl, type AccessRequest, type ModuleSummary, type SearchHit } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { notificationTone } from '../lib/notificationTone';
import { LiveCallDeck } from './LiveCallDeck';
import { TaskBuzzer } from './TaskBuzzer';
import { useDockFolded, WorkspaceDock } from './WorkspaceDock';
import { AiBubble } from './AiBubble';
import { cn } from '../lib/utils';
import { TOOLBAR_ICON_SIZE, toolbarIcon } from '../lib/toolbarIcon';
import { resolveIcon } from '../lib/icons';
import { ErrorBoundary } from './ErrorBoundary';
import { Avatar, Badge, Dropdown, DropdownItem, Modal, Spinner } from './ui';
import AiAssistant from './AiAssistant';
import { PeekLink, PeekProvider } from './PeekLink';
import { flattenGroups, groupHits, moveHighlight } from '../lib/searchGroups';
import { readRecent, withRecent, withoutRecent, writeRecent } from '../lib/searchHistory';
import RecordForm from './RecordForm';
import { SearchOptions } from './SearchOptions';

/* Lazy, because capture carries the camera and EXIF machinery and the shell is
   on every page. Nobody pays for it until they open the menu and choose it. */
const SiteCapture = lazy(() => import('../pages/SiteCapture'));

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
  /*
    The left toolbar's fold, held here rather than inside it — the hamburger
    beside the company name folds it (2 October 2026), and the hamburger is up
    here in the header.
  */
  const [dockFolded, setDockFolded] = useDockFolded();
  const location = useLocation();

  // One socket for the whole session: server-side changes (workflow tasks, AI
  // scoring, another user's edit) invalidate the matching queries live.
  useRealtime(Boolean(user));

  /*
    How big each module is, for the toolbar's counts — the owner, 2 October
    2026. Five minutes stale is fine: it is a sense of size, not a live figure,
    and refetching it on every record edit would cost one query per module.
  */
  const { data: moduleCounts } = useQuery({
    queryKey: ['record-counts'],
    queryFn: () => api.recordCounts(),
    staleTime: 300_000,
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

  return (
    <PeekProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-[var(--app-bg)]">
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
        <header data-main-toolbar className="relative z-40 flex h-14 shrink-0 items-center gap-1.5 border-b border-brand-900 bg-brand-800 px-3 text-white sm:px-4">
          {/*
            One hamburger, two jobs, and the job is whichever navigation this
            screen has — *"the toolbar also have hamburg function before ipropy
            company name"* (2 October 2026). On a phone there is no toolbar, so
            it opens the drawer; from `lg` up it folds the toolbar away.
          */}
          <button
            onClick={() => {
              if (window.matchMedia('(min-width: 1024px)').matches) setDockFolded(!dockFolded);
              else setDrawerOpen(true);
            }}
            className="btn-ghost p-2"
            aria-label={'Open menu'}
            title="Menu"
            data-testid="app-menu-button"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>

          <div className="flex shrink-0 items-center gap-2.5">
              <Link to="/dashboard" className="max-w-[10rem] truncate text-base font-semibold leading-tight tracking-tight">
                {brand?.orgName ?? 'iPropy'}
              </Link>
          </div>

          {/*
            The tags worth seeing from every screen, right after the company
            name — *"i need to quick see tags of 'For Sale, For Rent, Visit
            Done' in the main screen … at the top of Main Toolbar after IPROPY
            Company name"* (3 October 2026). Which tags is the data's answer,
            not a list written here: the most used ones, so the team's own
            vocabulary decides and a new tag arrives on its own.
          */}

          {/*
            The module switcher and the green WhatsApp button stood here until
            1 October 2026. The left toolbar carries both now, on every page —
            *"delete those leads dropdown sections and whatsapp tab as we know
            they came to left toolbar"*. The toolbar is `lg:` and up; below
            that the drawer carries every destination, and the WhatsApp button
            below stays for a phone, where the drawer is a tap further away.
          */}
          {/*
            WhatsApp, out of the menu and onto the bar.

            **20 September 2026, the owner:** *"bring this module right into
            the top header where that dropdown of leads and all is there …
            give it some tacky color maybe green or something else to
            highlight to team that this is whatsapp chat system here."*

            Green, and the only coloured thing on the bar, which is the whole
            point: one button the eye lands on without reading. It is not
            `lg:` like the switcher beside it — a rep on a laptop at 1200px or
            a tablet is exactly who lives in this screen, and the rule this
            repo already wrote down is that a destination living only in the
            switcher is invisible below 1024px.
          */}
          <NavLink
            to="/whatsapp"
            title="WhatsApp — the team's chats, campaigns and templates"
            className={({ isActive }) => cn(
              'flex shrink-0 items-center gap-1.5 lg:hidden rounded-lg border px-2.5 py-1.5 text-sm font-semibold transition-colors',
              /*
                A soft green pill everywhere else, and solid green while you
                are in WhatsApp — the way a selected tab looks, so the change
                reads as "you are here". It used to go from green to a dark
                teal (#075E54) on its own page, which the owner found heavy
                (25 September). #0B8043 is WhatsApp's green darkened until
                white on it clears AA; the brand's own #25D366 is 1.98:1.
              */
              isActive
                ? 'border-[#0B8043] bg-[#0B8043] text-white shadow-sm'
                : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:border-emerald-300 hover:bg-emerald-100 '
                  + 'dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/50',
            )}
          >
            <MessagesSquare className="h-4 w-4" />
            <span className="hidden sm:inline">WhatsApp</span>
          </NavLink>

          {/* Search sits beside the tabs, and shrinks before the tabs do. */}
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1">
            <NewRecordButton modules={menuModules} />
            {/* A list page puts its New (recently added) chip here. */}
            <div id="global-new-records" className="shrink-0" />
            <GlobalSearch />
            <div id="global-quick-dashboard" className="shrink-0" />
            <div id="global-quick-filter" className="shrink-0" />
            <div id="global-list-options" className="shrink-0" />

            <div className="flex shrink-0 items-center gap-1">
              <NotificationBell />

              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className={toolbarIcon('theme')}
                title="Toggle theme"
              >
                {theme === 'dark' ? <Sun className={TOOLBAR_ICON_SIZE} /> : <Moon className={TOOLBAR_ICON_SIZE} />}
              </button>

              <UserMenu />
            </div>
          </div>
        </header>

        {/* Mobile drawer: on a phone the tabs move to the bottom bar; the
            drawer keeps the full navigation for anything that is not on it. */}
        <MobileNav
          modules={menuModules}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />

        <LiveCallDeck />

        {/* Today's follow-ups, popping up one after another with a buzzer. */}
        <TaskBuzzer />

        {/* The bottom tab bar is fixed, so without this the last 64px of every
            page — a form's Save button included — sits behind it. */}
        {/* A wide list belongs to its own grid scroller. `min-w-0` prevents a
            table's minimum width from widening this page-level flex item and
            bypassing the list's frozen-column behaviour. */}
        {/*
          The left toolbar on every page, not only the lists — *"it needs to be
          fixed throughout the CRM all time"* (1 October 2026). Opening Calls
          used to take it away, which is exactly when a rep wants a way back.
        */}
        <div className="flex min-h-0 min-w-0 flex-1">
        <WorkspaceDock counts={moduleCounts} onFoldChange={setDockFolded} folded={dockFolded} />
        <main id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-16 lg:pb-0">
          {/* Per-page net. Keyed on the path so a crashed page clears itself
              when the user navigates away — without the key the boundary stays
              latched and every subsequent route renders the error screen. The
              header lives outside it and stays usable throughout. */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
        </div>

        {/* Ask AI, as a small circle that can be dragged anywhere — the way an
            iPhone's AssistiveTouch floats — rather than a button in the bar. */}
        {aiAvailable !== undefined && <AiBubble onOpen={() => setAiOpen(true)} />}

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
  /*
    Capture used to hang off a split button on the Properties list, which meant
    the one way into it was a page you had to be standing on. It is a way of
    adding a property, so it belongs with every other way of adding one — here,
    reachable from wherever you happen to be.
  */
  const [capturing, setCapturing] = useState(false);
  const canCapture = creatable.some((m) => m.name === 'properties');
  const queryClient = useQueryClient();
  const { data: createMeta, isLoading } = useQuery({
    queryKey: ['module', creating?.name],
    queryFn: () => api.module(creating!.name),
    enabled: Boolean(creating),
  });
  if (!creatable.length) return null;

  const captureModal = capturing ? (
    <Modal open onClose={() => setCapturing(false)} title="Capture on site" size="lg">
      <Suspense fallback={<div className="flex min-h-40 items-center justify-center"><Spinner className="h-5 w-5" /></div>}>
        <SiteCapture
          inModal
          onSaved={() => void queryClient.invalidateQueries({ queryKey: ['records', 'properties'] })}
        />
      </Suspense>
    </Modal>
  ) : null;

  const createModal = creating ? (
    <Modal open onClose={() => setCreating(null)} title={`New ${creating.singularLabel}`} size="lg">
      {isLoading || !createMeta ? (
        <div className="flex min-h-40 items-center justify-center"><Spinner className="h-5 w-5" /></div>
      ) : (
        <RecordForm
          module={createMeta}
          mode="quick_create"
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
  // entry is a click spent on confirming there was no choice to make. Unless
  // that module is Properties, which carries Capture as a second way in.
  if (creatable.length === 1 && !canCapture) {
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
          {canCapture && (
            <>
              <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
              <DropdownItem
                icon={<MapPin className="h-3.5 w-3.5" />}
                onClick={() => { close(); setCapturing(true); }}
              >
                Capture on site
              </DropdownItem>
            </>
          )}
        </>
      )}
    </Dropdown>
    {createModal}
    {captureModal}
    </>
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
      /*
        **2 October 2026, the owner:** *"in the avtar of Agent on main Screen
        please give a option of agent name and Designation of agent."* The
        corner was a face and nothing else, so on a shared machine the only way
        to find out who was signed in was to open the menu.

        The designation is the user's **role** — the one the CRM already knows
        and the one the menu has always shown. `hidden sm:flex` on the
        words: on a phone the face alone is right, and the header has no room
        for two more lines.
      */
      trigger={
        <button className="ml-1 flex items-center gap-2 rounded-lg p-1 hover:bg-white/10" data-testid="account-button">
          <Avatar name={user?.fullName ?? '?'} src={user?.avatarUrl} size={28} />
          <span className="hidden min-w-0 flex-col items-start leading-tight sm:flex">
            <span className="max-w-[9rem] truncate text-xs font-semibold text-white">
              {user?.fullName}
            </span>
            {user?.roleName && (
              <span className="max-w-[9rem] truncate text-[10px] text-slate-200">{user.roleName}</span>
            )}
          </span>
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
  modules, open, onClose,
}: {
  modules: { name: string; label: string; icon: string }[];
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
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-[var(--border)] bg-white transition-transform duration-200 ease-out dark:bg-slate-900 lg:hidden',
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
              />
            ))}
            <DrawerLink to="/capture" icon="map-pin" label="Site visit" />
          </div>
          <div className="space-y-0.5">
            <p className="mb-1 px-3 text-2xs font-semibold uppercase tracking-wider text-muted">Tools</p>
            {/* In the drawer as well as the header, because the switcher is
                `lg:block` and does not exist below 1024px — the rule this
                repo already learned twice, with Chats and then Reports. */}
            <DrawerLink to="/whatsapp" icon="message-circle" label="WhatsApp" />
            <DrawerLink to="/calls" icon="phone" label="Calls" />
            <DrawerLink to="/tools" icon="calculator" label="Calculators" />
            <DrawerLink to="/settings" icon="settings" label="Settings" />
          </div>
        </nav>
      </div>

      {/* The bottom tab bar a thumb reaches: the five destinations this desk
          lives on, WhatsApp-style. The active tab is the brand colour and the
          rest are quiet, so the eye lands without reading. */}
      <BottomTabs modules={modules} />
    </>
  );
}

function DrawerLink({
  to, icon, label,
}: { to: string; icon: string; label: string }): JSX.Element {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn('nav-item', isActive && 'nav-item-active')}
      aria-label={label}
    >
      <span className="shrink-0"><ModuleIcon name={icon} /></span>
      <span className="flex-1 truncate">{label}</span>
    </NavLink>
  );
}

function BottomTabs({
  modules,
}: {
  modules: { name: string; label: string; icon: string }[];
}): JSX.Element {
  const leads = modules.find((m) => m.name === 'leads');
  const properties = modules.find((m) => m.name === 'properties');
  const tabs = [
    { to: '/dashboard', icon: 'layout-dashboard', label: 'Dashboard' },
    leads && { to: `/${leads.name}`, icon: leads.icon, label: leads.label },
    properties && { to: `/${properties.name}`, icon: properties.icon, label: properties.label },
    { to: '/capture', icon: 'map-pin', label: 'Site visit' },
    { to: '/settings', icon: 'settings', label: 'You' },
  ].filter(Boolean) as { to: string; icon: string; label: string }[];

  /*
    The bar measures itself and publishes the result as `--bottom-nav-h`.

    Anything else fixed to the bottom of a phone screen has to sit above this
    bar, and the only two ways to know how tall it is were a hardcoded pixel
    count or this. The hardcoded version is wrong the moment a tab label wraps,
    the phone has a gesture bar of a different depth, or somebody turns the
    system font up — and being wrong means a Save button half-hidden behind the
    navigation, which is what shipped on the site-visit screen.

    Zero when the bar is not rendered, so a desktop layout is unaffected and a
    consumer needs no breakpoint of its own.
  */
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const publish = (): void => {
      document.documentElement.style.setProperty('--bottom-nav-h', `${el.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.setProperty('--bottom-nav-h', '0px');
    };
  }, []);

  return (
    <nav
      ref={navRef}
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 flex shrink-0 items-stretch justify-around border-t border-[var(--border)] bg-white pb-[env(safe-area-inset-bottom)] lg:hidden dark:bg-slate-900"
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
          <ModuleIcon name={tab.icon} className="h-5 w-5" />
          <span className="w-full truncate text-center">{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The organisation's logo, in a circle, beside its name.
 *
 * **2 October 2026, the owner:** on many laptops it did not show at all, and
 * where it did it did not look good. Two causes, both handled here: a logo the
 * browser cannot load (an expired sign-in token in its address, or a file that
 * has gone) left a broken-image box, so a failed load now falls back to the
 * first letter of the name; and a square logo squeezed into a rounded square
 * read as cropped, so it is a circle with a soft ring now, the picture covering
 * it edge to edge.
 */
function BrandMark({ logoUrl, name }: { logoUrl: string | null; name: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logoUrl]);
  /*
    **4 October 2026, the owner, with a screenshot of the header:** *"Company
    Profile Logo, Poor Alignment & Size adjustment."*

    **A circle is the wrong frame for a company logo, and that is the whole
    fault.** It was a 32px round box with a ring round it, so a wide wordmark —
    which is what almost every company's logo is — had to fit its whole width
    inside 32px of height, coming out a few pixels tall and unreadable; and the
    ring, drawn *outside* the box, pressed against the row's own padding, which
    is the "poor alignment" half. Three evenings of this file were spent making
    that circle bigger, darker, then smaller again, which is the clue that the
    shape was never the thing to adjust.

    So a real logo is now drawn **as the shape it is**: full height of the bar's
    comfortable 36px, whatever width that gives it, capped so it cannot push the
    rest of the bar off a phone. No ring and no crop — a logo is already a
    finished piece of design and a border round it is one more thing to clash
    with. The round badge stays for the **initial**, which is the one case a
    circle fits, because a single letter has no width of its own.

    Plain brand steps, never an opacity modifier: these resolve to a bare
    `var(--brand-…)`, so `ring-brand-600/40` would compile to nothing at all.
  */
  if (logoUrl && !failed) {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border-[3px] border-brand-700 bg-white p-0.5" data-testid="brand-mark">
        {/* A CRM-hosted logo is permission-checked, and an <img> cannot send
            the session header — so the token rides in the query string.
            `object-contain` preserves the full logo inside the ring. */}
        <img
          src={authedFileUrl(logoUrl)}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border-[3px] border-brand-700 bg-gradient-to-br from-brand-500 to-brand-700 text-base font-bold text-white shadow-sm"
      data-testid="brand-mark"
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || 'i'}
    </span>
  );
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
          className={cn(toolbarIcon('bell'), 'group-data-[open=true]/dropdown:ring-2 group-data-[open=true]/dropdown:ring-current')}
          title="Notifications"
          aria-label={unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}
        >
          <Bell className={TOOLBAR_ICON_SIZE} />
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
                    'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                    notificationTone(n.kind, n.link),
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


/**
 * A record the words matched that this person is not allowed to open.
 *
 * **Not a link, because there is nothing to open.** The row exists to answer
 * one question — *is this person already ours, and whose?* — and it carries a
 * name and an owner and nothing else. Anything more would be a way around the
 * sharing rules rather than a courtesy inside them.
 *
 * **3 October 2026, the owner:** *"if agent want to access the display record,
 * he can ask to actual owner of record for the permission to assigned him, Now
 * The actual user can change the owner of record."* So the row has one button.
 * Pressing it writes a request and notifies the owner; it grants nothing by
 * itself, and `getRecord` still refuses the record until the owner hands it
 * over.
 */
function RestrictedHit({ hit }: { hit: SearchHit }): JSX.Element {
  const [asked, setAsked] = useState(false);
  const ask = useMutation({
    mutationFn: () => api.requestAccess(hit.id),
    onSuccess: (request: AccessRequest) => {
      setAsked(true);
      toast.success(
        request.status === 'pending' && new Date(request.createdAt).getTime() < Date.now() - 5_000
          ? 'You have already asked for this one'
          : `Asked ${hit.ownerName ?? 'the owner'} for this record`,
      );
    },
    onError: (error: Error) => toast.error('Could not ask for that record', error.message),
  });
  /*
    A record with a real id is one the owner can be asked for. The phone-shaped
    lookup answers `restricted:<module>` instead, deliberately — it carries no
    id at all — so that row keeps saying what it always said and offers no
    button rather than a button that could only fail.
  */
  const canAsk = !hit.id.startsWith('restricted:');
  return (
    <div
      className="flex items-start gap-2 border-l-2 border-amber-400 bg-amber-50/60 px-3 py-2 dark:bg-amber-950/30"
      data-testid="restricted-hit"
    >
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{hit.label}</p>
        <p className="text-xs text-muted">
          Already in {hit.moduleLabel}, assigned to{' '}
          <strong className="font-medium text-slate-700 dark:text-slate-200">
            {hit.ownerName ?? 'nobody yet'}
          </strong>
          . Not shared with you.
        </p>
      </div>
      {canAsk && (
        <button
          type="button"
          disabled={asked || ask.isPending}
          onClick={(event) => { event.stopPropagation(); ask.mutate(); }}
          className="btn-secondary btn-sm shrink-0"
        >
          {asked ? 'Asked' : ask.isPending ? 'Asking…' : 'Ask for access'}
        </button>
      )}
    </div>
  );
}

function GlobalSearch(): JSX.Element {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [highlight, setHighlight] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
    **4 October 2026, the owner, with a design of the panel he wants:** *"We need
    search as a more/much dynamic in the Main/top toolbar, we can search
    everything, the result shown in list. by source of result and last search
    also shown in below … we want word's all dynamic features in this search,
    means most advance label search engine of our crm."*

    What it replaced was a flat list of names with the module on a chip at the
    end of each row. Four things changed, and none of them is a new search
    engine: the answers are **grouped by the module they came from** with a count
    on each heading; each row says who owns the record and when it was last
    touched, so two people called Sharma can be told apart without opening both;
    **↑ ↓ and ↵** walk and open them; and the **last five searches** sit under
    the box with an × each.

    The searching itself is the same one endpoint — `GET /api/search` — which is
    the whole reason this was a day and not a month. It already reads as the
    person asking, already narrows a comma-separated list, and already says when
    a number belongs to a colleague's customer.
  */
  const groups = useMemo(() => groupHits(results), [results]);
  const flat = useMemo(() => flattenGroups(groups), [groups]);

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

  /*
    A new **question** starts with nothing highlighted, so ↵ cannot open a row
    that has just been replaced by a different record under the cursor.

    Keyed on the query and deliberately **not** on the answers: the answers
    arrive a beat after the typing stops, and resetting on them threw away a ↓
    pressed in that beat — which is exactly when a fast typist presses it. The
    highlight then stayed at nothing and ↵ did something else entirely. Found in
    a browser; nothing else could have shown it.
  */
  useEffect(() => setHighlight(-1), [query]);

  /*
    Keep the walked-to row on screen. The panel scrolls, and ten answers in two
    groups is taller than it — so ↓ past the sixth highlighted a row nobody could
    see, and ↵ then opened a record that had never been in front of anybody.
    `block: 'nearest'` so an already-visible row does not jump the list about.
  */
  useEffect(() => {
    if (highlight < 0) return;
    ref.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  /** Remember what was searched — only once it has been acted on, never per keystroke. */
  const remember = (term: string): void => {
    const next = withRecent(recent, term);
    setRecent(next);
    writeRecent(next);
  };

  const forget = (term: string): void => {
    const next = withoutRecent(recent, term);
    setRecent(next);
    writeRecent(next);
  };

  const openHit = (hit: SearchHit): void => {
    if (hit.restricted) return;
    remember(query);
    setOpen(false);
    setQuery('');
    navigate(`/${hit.module}/${hit.id}`);
  };

  /** Everything this module matched, in its own list, where it can be filtered further. */
  const openModule = (module: string): void => {
    remember(query);
    setOpen(false);
    const term = query;
    setQuery('');
    navigate(`/${module}?q=${encodeURIComponent(term)}`);
  };

  const onBoxKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => moveHighlight(current, event.key === 'ArrowDown' ? 1 : -1, flat.length));
      return;
    }
    if (event.key === 'Enter') {
      /*
        ↵ with nothing highlighted opens the first module's full list rather than
        guessing a record. Pressing it is "show me these", and opening the top
        answer because it happened to be first is how a rep ends up on somebody
        else's record with no idea why.
      */
      const chosen = flat[highlight];
      if (chosen) openHit(chosen);
      else if (groups[0]) openModule(groups[0].module);
    }
  };

  const showRecent = open && query.trim().length < 2 && recent.length > 0;

  return (
    <div className="relative ml-auto min-w-0 flex-1 max-w-[48rem]" ref={ref}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        className="input h-11 rounded-2xl border-[var(--border)] bg-white pl-10 pr-20 text-sm dark:bg-slate-800 dark:focus:bg-slate-900"
        placeholder="Search everything…"
        aria-label="Search everything"
        value={query}
        role="combobox"
        aria-expanded={open}
        aria-controls="global-search-results"
        onFocus={() => setOpen(true)}
        onKeyDown={onBoxKey}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div id="global-search-filter" className="absolute right-2 top-1/2 -translate-y-1/2"><SearchOptions words={query} onWordsChange={setQuery} onOpen={() => setOpen(false)} /></div>
      <kbd className="pointer-events-none absolute right-12 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-muted dark:border-slate-700 sm:block">
        ⌘K
      </kbd>

      {/* The last five searches, with the box still empty — his *"last search
          also shown in below"*. Offered only where it would say something: an
          empty row of nothing is worse than no row. */}
      {showRecent && (
        <div className="popover absolute z-40 mt-1 w-full p-2" data-testid="search-recent">
          <p className="px-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted">Last search</p>
          <div className="flex flex-wrap gap-1.5">
            {recent.map((term) => (
              <span
                key={term}
                className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-white py-1 pl-2.5 pr-1 text-xs dark:bg-slate-800"
              >
                <button
                  type="button"
                  className="max-w-[9rem] truncate font-medium"
                  onClick={() => { setQuery(term); inputRef.current?.focus(); }}
                >
                  {term}
                </button>
                <button
                  type="button"
                  aria-label={`Forget “${term}”`}
                  className="rounded-full p-0.5 text-muted hover:bg-slate-100 dark:hover:bg-slate-700"
                  onClick={() => forget(term)}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {open && query.trim().length >= 2 && (
        <div className="popover absolute z-40 mt-1 max-h-[26rem] w-full overflow-y-auto" id="global-search-results" role="listbox">
          {loading && <div className="flex justify-center py-6"><Spinner className="text-slate-400" /></div>}
          {!loading && results.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted">No matches for “{query}”</p>
          )}

          {groups.map((group) => (
            <div key={group.module} data-search-module={group.module}>
              {/* The heading says where these came from, how many, and is the
                  way to the module's own list with the same words in its box. */}
              <div className="sticky top-0 flex items-center gap-2 bg-[var(--surface-muted)] px-3 py-1.5">
                <span className="truncate text-[10px] font-bold uppercase tracking-wider text-muted">{group.label}</span>
                <Badge className="shrink-0">{group.hits.length}</Badge>
                <button
                  type="button"
                  className="ml-auto shrink-0 text-[10px] font-semibold text-brand-700 hover:underline dark:text-brand-300"
                  onClick={() => openModule(group.module)}
                >
                  See all
                </button>
              </div>
              {group.hits.map((hit) => (hit.restricted ? (
                <RestrictedHit key={hit.id} hit={hit} />
              ) : (
                <PeekLink
                  key={hit.id}
                  module={hit.module}
                  id={hit.id}
                  label={hit.label}
                  // A modified click opens a background tab and the browser leaves
                  // this page alone — so clearing the box would throw away the
                  // results somebody is deliberately working through one at a time.
                  onNavigate={() => { remember(query); setOpen(false); setQuery(''); }}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left [-webkit-touch-callout:none]',
                    /*
                      One class string per state, never two `bg-*` utilities in
                      one list: Tailwind decides between them by where they sit
                      in its own stylesheet, not by the order they are typed.
                    */
                    flat[highlight]?.id === hit.id
                      ? 'bg-brand-50 dark:bg-slate-700'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                  selected={flat[highlight]?.id === hit.id}
                >
                  <Avatar name={hit.label} size={28} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-semibold"><span className="truncate">{hit.label}</span>{hit.mobile && <span className="shrink-0 text-xs font-medium text-slate-600 dark:text-slate-300">{hit.mobile}</span>}<span className="ml-auto truncate text-[10px] font-normal text-muted">{[hit.recordNumber, hit.ownerName, hit.updatedAt && relativeTime(hit.updatedAt)].filter(Boolean).join(' · ')}</span></span>
                    {/* What tells two people of the same name apart. Each part
                        is skipped when it is empty rather than printed as a
                        dash — a sub-line of separators says nothing. */}
                    <span className="block truncate text-[11px] text-muted" title={hit.details}>
                      {hit.details || [hit.recordNumber, hit.ownerName, hit.updatedAt && relativeTime(hit.updatedAt)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </PeekLink>
              )))}
            </div>
          ))}

          {/* The keys, said once at the foot — his design's own footer. */}
          {!loading && flat.length > 0 && (
            <p className="flex items-center gap-3 border-t border-[var(--border)] px-3 py-1.5 text-[10px] text-muted">
              <span><kbd className="font-sans">↑↓</kbd> to move</span>
              <span><kbd className="font-sans">↵</kbd> to open</span>
              <span className="ml-auto"><kbd className="font-sans">esc</kbd> to close</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
