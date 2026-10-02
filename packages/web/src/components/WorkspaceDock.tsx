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
import { type JSX, type ReactNode, useCallback, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight, LayoutDashboard, MessagesSquare, PhoneIncoming } from 'lucide-react';
import { useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { ModuleIcon } from './Layout';

const FOLDED_KEY = 'ipropy.dock.folded';

/**
 * Folded or not is this browser's choice, like the right pane's.
 *
 * Exported because the header's hamburger folds it too (2 October 2026) — one
 * piece of state, read in two places, rather than two that drift apart.
 */
export function useDockFolded(): [boolean, (folded: boolean) => void] {
  const [folded, setFoldedState] = useState(() => {
    try { return localStorage.getItem(FOLDED_KEY) === '1'; } catch { return false; }
  });
  const setFolded = useCallback((next: boolean) => {
    setFoldedState(next);
    try { localStorage.setItem(FOLDED_KEY, next ? '1' : '0'); } catch { /* private window: forget on reload */ }
  }, []);
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
  const entityModules = modules.filter((module) => module.isEntity);
  const setFolded = onFoldChange;
  return (
    <div
      className={cn(
        'relative hidden shrink-0 overflow-hidden border-r border-slate-200 transition-[width] duration-300 ease-in-out dark:border-slate-800 lg:block',
        // Wide enough for a name beside every icon — *"all icon have their
        // names"* (2 October 2026). Folded it is the same slim strip it was.
        folded ? 'w-7' : 'w-52',
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
          <DockLink to="/dashboard" label="Dashboard">
            <LayoutDashboard className="h-[18px] w-[18px]" />
          </DockLink>
          {entityModules.map((module) => (
            <DockLink key={module.name} to={`/${module.name}`} label={module.label} count={counts?.[module.name]}>
              <ModuleIcon name={module.icon} className="h-[18px] w-[18px]" />
            </DockLink>
          ))}
          <DockLink to="/calls" label="Calls">
            <PhoneIncoming className="h-[18px] w-[18px]" />
          </DockLink>
          <DockLink to="/whatsapp" label="WhatsApp" tone="whatsapp">
            <MessagesSquare className="h-[18px] w-[18px]" />
          </DockLink>
        </div>
      </aside>
      {folded ? (
        <button
          type="button"
          onClick={() => setFolded(false)}
          title="Show the toolbar"
          aria-label="Show the toolbar"
          aria-expanded={false}
          className="absolute inset-0 z-20 flex flex-col items-center gap-2 bg-brand-50 pt-3 text-brand-700 transition hover:bg-brand-100 dark:bg-slate-800 dark:text-brand-300 dark:hover:bg-slate-700"
          data-testid="unfold-dock"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white shadow-sm"><ChevronRight className="h-3.5 w-3.5" strokeWidth={2.5} /></span>
          <span className="text-[10px] font-bold uppercase tracking-widest [writing-mode:vertical-rl] rotate-180">Menu</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setFolded(true)}
          title="Fold the toolbar away"
          aria-label="Fold the toolbar"
          aria-expanded
          className="absolute right-0 top-1/2 z-20 flex h-12 w-4 -translate-y-1/2 items-center justify-center rounded-l-lg bg-brand-600 text-white shadow-md transition hover:w-5 hover:bg-brand-700"
          data-testid="fold-dock"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

function DockLink({ to, label, count, tone, children }: {
  to: string;
  label: string;
  /** How many records this module holds. Absent for a destination that is not one. */
  count?: number;
  /** `whatsapp` keeps its own green, which is how a rep finds it without reading. */
  tone?: 'whatsapp';
  children: ReactNode;
}): JSX.Element {
  // A module's icon stays lit on its records too (`/leads/…`).
  return (
    <NavLink
      to={to}
      end={false}
      title={label}
      className={({ isActive }) => dockLook(isActive, tone)}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">{children}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {/*
        The module's own size, and **not** an unread count — that feature is
        off the toolbar on the owner's instruction (2 October 2026). A count
        of nothing is not drawn: a grey zero beside every module is noise.
      */}
      {count ? (
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
function dockLook(on: boolean, tone?: 'whatsapp'): string {
  return cn(
    'flex h-10 w-full shrink-0 items-center gap-2.5 rounded-xl px-2 text-sm font-semibold transition',
    tone === 'whatsapp' && !on && 'text-[#0B8043] hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950',
    on
      ? 'border border-slate-200/80 bg-white text-brand-600 shadow-xs dark:border-slate-700 dark:bg-slate-800 dark:text-brand-300'
      : !tone && 'text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800',
  );
}
