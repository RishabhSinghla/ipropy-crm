/**
 * The slim vertical toolbar down the left of every page.
 *
 * **30 September 2026, the owner's prototype:** *"the toolbar and Icons move in
 * new vertical toolbar"* — a WhatsApp-style dock of round icons. **1 October
 * 2026:** *"it needs to be fixed throughout the CRM all time"* — it lived only
 * on the lists, so opening Calls took it away. It is part of the app's frame
 * now (`Layout.tsx`), and it replaces the module switcher and the WhatsApp
 * button that used to sit in the top bar.
 *
 * Every icon is a place that already exists. The Tasks and Campaigns icons
 * went on 3 October 2026 — *"not needed here"*: Campaigns is a tab of
 * WhatsApp, and today's follow-ups are the Task button over each list.
 *
 * From `lg` up. Below that the app's drawer carries the same destinations.
 * It folds to a slim strip and back since 1 October 2026; see below.
 *
 * No Settings gear and no account circle at its foot since 2 October 2026 —
 * *"get rid of both of it"*. Settings is still in the menu under the avatar
 * at the top right, which is where it always was.
 */
import { type JSX, type ReactNode, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, MessagesSquare, PhoneIncoming, Star } from 'lucide-react';
import { useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { ModuleIcon } from './Layout';
import { hasFavouriteFilter } from '../lib/favouritesFilter';

/**
 * Folded or not, for as long as this tab is open.
 *
 * Exported because the header's hamburger folds it too (2 October 2026) — one
 * piece of state, read in two places, rather than two that drift apart.
 *
 * **Folded on arrival, every time** — the owner, 3 October 2026: *"the Right
 * Pane Detail Form Window are by the default close, when we Refresh or Login
 * to CRM, if we need i will open it, same are in the Left Toolbar pane."* So
 * it is deliberately not remembered: the CRM opens with the work in the middle
 * of the screen and the toolbar out of the way, and opening it is a decision
 * for right now rather than a standing preference. Folded is **not** blank any
 * more either — see below.
 */
export function useDockFolded(): [boolean, (folded: boolean) => void] {
  const [folded, setFolded] = useState(true);
  return [folded, setFolded];
}

/*
  Folds away and back like the right-hand details pane — the owner, 1 October
  2026: *"similar to that fold unfold thing we got on very right detail pane so
  that left tool bar would be same working open/closed"*. Same pieces, mirrored:
  a brand tab on the inner edge folds it, a tinted strip with a round chevron
  brings it back, the width slides, the icons fade, and `inert` keeps a folded
  dock out of the Tab order.
*/
export function WorkspaceDock({ counts, folded, onFoldChange }: {
  /**
   * How many records each module holds, as this user may see them.
   *
   * **2 October 2026, the owner:** *"all icon have their names also with
   * record counts and the unread feature disables from all modules's
   * toolbar."* It used to be "not opened yet", which is a number only the CRM
   * cares about; this is the module's own size.
   */
  counts?: Record<string, number>;
  /** Owned by `Layout`, so the header's hamburger folds the same toolbar. */
  folded: boolean;
  onFoldChange: (folded: boolean) => void;
}): JSX.Element {
  const { modules } = useApp();
  const here = useLocation().pathname.split('/')[1];
  const favouriteModule = modules.find((module) => module.isEntity && module.name === here)?.name
    ?? modules.find((module) => module.isEntity)?.name ?? 'leads';
  const entityModules = modules.filter((module) => module.isEntity);
  /*
    The same destinations either way, so folding changes how a row is *drawn*
    and never which rows exist. Two lists would be two things to keep in step,
    and the way that drifts is a module appearing in one and not the other.
  */
  const rows: Array<{ to: string; label: string; icon: JSX.Element; count?: number; tone?: 'whatsapp' }> = [
    { to: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="h-[18px] w-[18px]" /> },
    ...entityModules.map((module) => ({
      to: `/${module.name}`,
      label: module.label,
      icon: <ModuleIcon name={module.icon} className="h-[18px] w-[18px]" />,
      count: counts?.[module.name],
    })),
    { to: '/calls', label: 'Calls', icon: <PhoneIncoming className="h-[18px] w-[18px]" /> },
    { to: `/${favouriteModule}?filter=${encodeURIComponent(JSON.stringify({ logic: 'AND', conditions: [{ field: 'favourite', operator: 'is_true' }] }))}`, label: 'Favourites', icon: <Star className="h-[18px] w-[18px]" /> },
    { to: '/whatsapp', label: 'WhatsApp', icon: <MessagesSquare className="h-[18px] w-[18px]" />, tone: 'whatsapp' as const },
  ];
  return (
    <div
      className={cn(
        'relative hidden shrink-0 overflow-hidden border-r border-slate-200 transition-[width] duration-300 ease-in-out dark:border-slate-800 lg:block',
        // Wide enough for a name beside every icon — *"all icon have their
        // names"* (2 October 2026). Folded it is a column of those same icons,
        // on his instruction of 3 October: *"when we close the window the the
        // Icons of Module should be show instead of plane."* A blank strip
        // meant a rep had to open the toolbar to find out what was in it.
        folded ? 'w-14' : 'w-52',
      )}
      data-testid="workspace-dock-frame"
      data-folded={folded ? 'true' : undefined}
    >
      <aside
        inert={folded}
        className={cn(
          'flex h-full w-52 flex-col overflow-y-auto bg-[#f0f2f5] py-3 no-scrollbar transition-opacity duration-200 dark:bg-slate-900',
          folded ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
        aria-label="Workspace toolbar"
        data-testid="workspace-dock"
      >
        {/*
          The order the owner drew on 2 October 2026 — *"Whatsapp icon Shift to
          Below Call and Dashboard icon on top"*. Dashboard, then the modules a
          rep works, then the call log, then WhatsApp at the foot.
        */}
        <div className="flex flex-col gap-1 px-2">
          {rows.map((row) => (
            <DockLink key={row.to} to={row.to} label={row.label} count={row.count} tone={row.tone}>
              {row.icon}
            </DockLink>
          ))}
        </div>
      </aside>
      {folded ? (
        /*
          **Folded is icons, not a blank strip** (3 October 2026). Every row is
          the same destination, drawn as its icon alone with the name on hover
          and for a screen reader, and the round chevron at the top opens the
          toolbar rather than the whole strip being one button — a column you
          cannot click through is a column that costs a click to use.
        */
        <nav
          className="absolute inset-0 z-20 flex flex-col items-center gap-1 overflow-y-auto bg-[#f0f2f5] py-2 no-scrollbar dark:bg-slate-900"
          aria-label="Workspace toolbar"
          data-testid="workspace-dock-folded"
        >
          {rows.map((row) => (
            <DockLink key={row.to} to={row.to} label={row.label} count={row.count} tone={row.tone} iconOnly>
              {row.icon}
            </DockLink>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

function DockLink({ to, label, count, tone, iconOnly = false, children }: {
  to: string;
  label: string;
  /** How many records this module holds. Absent for a destination that is not one. */
  count?: number;
  /** `whatsapp` keeps its own green, which is how a rep finds it without reading. */
  tone?: 'whatsapp';
  /** The folded strip: the icon alone, with the name on hover and for a reader. */
  iconOnly?: boolean;
  children: ReactNode;
}): JSX.Element {
  // A module's icon stays lit on its records too (`/leads/…`).
  const location = useLocation();
  const favouritesOn = (() => {
    try { return hasFavouriteFilter(JSON.parse(new URLSearchParams(location.search).get('filter') ?? '{}')); }
    catch { return false; }
  })();
  return (
    <NavLink
      state={label === 'Favourites' ? { searchHandoff: Date.now() } : undefined}
      to={to}
      end={false}
      title={count ? `${label} — ${count.toLocaleString('en-IN')}` : label}
      aria-label={label}
      aria-current={label === 'Favourites' && favouritesOn ? 'page' : undefined}
      className={({ isActive }) => dockLook(label === 'Favourites' ? favouritesOn : isActive && !(favouritesOn && to === location.pathname), tone, iconOnly)}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">{children}</span>
      {!iconOnly && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {/*
        The module's own size, and **not** an unread count — that feature is
        off the toolbar on the owner's instruction (2 October 2026). A count
        of nothing is not drawn: a grey zero beside every module is noise.
      */}
      {count && !iconOnly ? (
        <span
          className="shrink-0 rounded-full bg-slate-200 px-1.5 text-[10px] font-bold leading-[1.1rem] text-slate-700 tnum dark:bg-slate-700 dark:text-slate-100"
          title={`${count.toLocaleString('en-IN')} ${label.toLowerCase()}`}
        >
          {count > 999 ? `${Math.floor(count / 1000)}k` : count}
        </span>
      ) : null}
    </NavLink>
  );
}

/** The one look for a dock row: a white tile when it is where you are, a quiet one when it is not. */
function dockLook(on: boolean, tone?: 'whatsapp', iconOnly = false): string {
  return cn(
    'flex h-10 shrink-0 items-center rounded-xl text-sm font-semibold transition',
    iconOnly ? 'w-10 justify-center' : 'w-full gap-2.5 px-2',
    /*
      `#0a7038`, not WhatsApp's own `#0B8043`, and the contrast scan is what
      said so: on this toolbar's `#f0f2f5` their green is **4.48:1**, which is
      under AA by two hundredths. A row nobody can read is not branding. The
      filled circle elsewhere keeps the real green, because white on it is a
      different pair.
    */
    tone === 'whatsapp' && !on && 'text-[#0a7038] hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950',
    on
      ? 'border border-brand-300 bg-brand-100 text-brand-700 shadow-xs dark:border-brand-600 dark:bg-brand-950 dark:text-brand-300'
      : !tone && 'text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800',
  );
}
