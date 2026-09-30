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
 * Every icon is a place that already exists. Tasks opens the module you are in
 * (or the first one) on today's follow-ups, through `?task=today`, which the
 * list reads on arrival — the same queue the Task button there opens.
 *
 * From `lg` up. Below that the app's drawer carries the same destinations.
 *
 * No Settings gear and no account circle at its foot since 2 October 2026 —
 * *"get rid of both of it"*. Settings is still in the menu under the avatar
 * at the top right, which is where it always was.
 */
import { type JSX, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { CheckCircle2, LayoutDashboard, Megaphone, MessagesSquare, PhoneIncoming } from 'lucide-react';
import { useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { ModuleIcon } from './Layout';

export function WorkspaceDock({ unseen }: {
  /** Records nobody has opened yet, per module — the switcher's old badge. */
  unseen?: Record<string, number>;
}): JSX.Element {
  const { modules } = useApp();
  const location = useLocation();
  const entityModules = modules.filter((module) => module.isEntity);
  const here = location.pathname.split('/')[1] ?? '';
  const taskModule = entityModules.find((module) => module.name === here) ?? entityModules[0];
  const onTasks = new URLSearchParams(location.search).get('task') === 'today';
  return (
    <aside
      className="hidden w-14 shrink-0 flex-col items-center overflow-y-auto border-r border-slate-200 bg-[#f0f2f5] py-3 no-scrollbar dark:border-slate-800 dark:bg-slate-900 lg:flex"
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
          <DockLink key={module.name} to={`/${module.name}`} label={module.label} exact badge={unseen?.[module.name]}>
            <ModuleIcon name={module.icon} className="h-[18px] w-[18px]" />
          </DockLink>
        ))}
        <DockLink to="/calls" label="Call log">
          <PhoneIncoming className="h-[18px] w-[18px]" />
        </DockLink>
        {taskModule && (
          <NavLink
            to={onTasks ? `/${taskModule.name}` : `/${taskModule.name}?task=today`}
            title={onTasks ? 'Show every record again' : "Today's tasks"}
            aria-label="Today's tasks"
            aria-current={onTasks ? 'page' : undefined}
            className={dockLook(onTasks)}
          >
            <CheckCircle2 className="h-[18px] w-[18px]" />
          </NavLink>
        )}
        <DockLink to="/whatsapp/campaigns" label="Campaigns">
          <Megaphone className="h-[18px] w-[18px]" />
        </DockLink>
      </div>
    </aside>
  );
}

function DockLink({ to, label, exact = false, badge, children }: {
  to: string; label: string; exact?: boolean; badge?: number; children: ReactNode;
}): JSX.Element {
  const location = useLocation();
  // A module's icon stays lit on its records too (`/leads/…`), but not while
  // the Tasks icon is the one that is on.
  const onTasks = new URLSearchParams(location.search).get('task') === 'today';
  return (
    <NavLink
      to={to}
      end={false}
      title={label}
      aria-label={label}
      className={({ isActive }) => cn(dockLook(isActive && !(exact && onTasks)), 'relative')}
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
