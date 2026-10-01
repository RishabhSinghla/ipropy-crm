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

/** Folded or not is this browser's choice, like the right pane's. */
function useDockFolded(): [boolean, (folded: boolean) => void] {
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
export function WorkspaceDock({ unseen }: {
  /** Records nobody has opened yet, per module — the switcher's old badge. */
  unseen?: Record<string, number>;
}): JSX.Element {
  const { modules } = useApp();
  const entityModules = modules.filter((module) => module.isEntity);
  const [folded, setFolded] = useDockFolded();
  return (
    <div
      className={cn(
        'relative hidden shrink-0 overflow-hidden border-r border-slate-200 transition-[width] duration-300 ease-in-out dark:border-slate-800 lg:block',
        folded ? 'w-7' : 'w-14',
      )}
      data-testid="workspace-dock-frame"
      data-folded={folded ? 'true' : undefined}
    >
      <aside
        inert={folded}
        className={cn(
          'flex h-full w-14 flex-col items-center overflow-y-auto bg-[#f0f2f5] py-3 no-scrollbar transition-opacity duration-200 dark:bg-slate-900',
          folded ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
        aria-label="Workspace toolbar"
        data-testid="workspace-dock"
      >
        <div className="flex flex-col items-center gap-3.5">
          <NavLink
            to="/whatsapp"
            title="WhatsApp"
            aria-label="WhatsApp"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0B8043] text-white shadow-sm transition hover:opacity-95"
          >
            <MessagesSquare className="h-5 w-5" />
          </NavLink>
          <span className="h-px w-7 shrink-0 bg-slate-300 dark:bg-slate-700" />
          <DockLink to="/dashboard" label="Dashboard">
            <LayoutDashboard className="h-[18px] w-[18px]" />
          </DockLink>
          {entityModules.map((module) => (
            <DockLink key={module.name} to={`/${module.name}`} label={module.label} badge={unseen?.[module.name]}>
              <ModuleIcon name={module.icon} className="h-[18px] w-[18px]" />
            </DockLink>
          ))}
          <DockLink to="/calls" label="Call log">
            <PhoneIncoming className="h-[18px] w-[18px]" />
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

function DockLink({ to, label, badge, children }: {
  to: string; label: string; badge?: number; children: ReactNode;
}): JSX.Element {
  // A module's icon stays lit on its records too (`/leads/…`).
  return (
    <NavLink
      to={to}
      end={false}
      title={label}
      aria-label={label}
      className={({ isActive }) => cn(dockLook(isActive), 'relative')}
    >
      {children}
      {badge ? (
        <span className="absolute -right-1.5 -top-1.5 min-w-[1.1rem] rounded-full bg-brand-600 px-1 text-center text-[9px] font-bold leading-4 text-white ring-2 ring-[#f0f2f5] dark:ring-slate-900" title={`${badge} not opened yet`}>
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </NavLink>
  );
}

/** The one look for a dock icon: a white tile when it is where you are, a quiet one when it is not. */
function dockLook(on: boolean): string {
  return cn(
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
    on
      ? 'border border-slate-200/80 bg-white text-brand-600 shadow-xs dark:border-slate-700 dark:bg-slate-800 dark:text-brand-300'
      : 'text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800',
  );
}
