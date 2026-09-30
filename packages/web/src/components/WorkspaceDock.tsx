/**
 * The slim vertical toolbar at the left of the split view.
 *
 * **30 September 2026, the owner's prototype:** *"the toolbar and Icons move in
 * new vertical toolbar"* — a WhatsApp-style dock of round icons, so the record
 * pane beside it keeps its whole width for the queue. WhatsApp first, in its
 * own green, then the modules, the call log, the tasks and campaigns; settings and who
 * you are at the foot.
 *
 * Every icon is a place that already exists, or the Task filter the list
 * already has. Nothing here is a second copy of a screen — the dock only moves
 * the doors closer.
 *
 * Only on a wide screen (`xl`), where the four panes sit side by side. Below
 * that the panes stack and the app's own header and drawer carry the same
 * destinations.
 */
import { type JSX, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { CheckCircle2, Megaphone, MessagesSquare, PhoneIncoming, Settings } from 'lucide-react';
import { useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { ModuleIcon } from './Layout';
import { Avatar } from './ui';

export function WorkspaceDock({ tasksOn, onTasks }: {
  /** Whether the list is narrowed to today's tasks right now. */
  tasksOn?: boolean;
  /** Absent where the module has no follow-up date, so there is no Tasks icon. */
  onTasks?: () => void;
}): JSX.Element {
  const { modules, user } = useApp();
  const entityModules = modules.filter((module) => module.isEntity);
  return (
    <aside
      className="hidden w-14 shrink-0 flex-col items-center justify-between border-r border-slate-200 bg-[#f0f2f5] py-3 dark:border-slate-800 dark:bg-slate-900 xl:flex"
      aria-label="Workspace toolbar"
      data-testid="workspace-dock"
    >
      <div className="flex flex-col items-center gap-3.5">
        <NavLink
          to="/whatsapp"
          title="WhatsApp"
          aria-label="WhatsApp"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-[#0B8043] text-white shadow-sm transition hover:opacity-95"
        >
          <MessagesSquare className="h-5 w-5" />
        </NavLink>
        <span className="h-px w-7 bg-slate-300 dark:bg-slate-700" />
        {entityModules.map((module) => (
          <DockLink key={module.name} to={`/${module.name}`} label={module.label}>
            <ModuleIcon name={module.icon} className="h-[18px] w-[18px]" />
          </DockLink>
        ))}
        <DockLink to="/calls" label="Call log">
          <PhoneIncoming className="h-[18px] w-[18px]" />
        </DockLink>
        {onTasks && (
          <button
            type="button"
            onClick={onTasks}
            aria-pressed={Boolean(tasksOn)}
            title={tasksOn ? 'Show every record again' : "Today's tasks"}
            aria-label="Today's tasks"
            className={dockLook(Boolean(tasksOn))}
          >
            <CheckCircle2 className="h-[18px] w-[18px]" />
          </button>
        )}
        <DockLink to="/whatsapp/campaigns" label="Campaigns">
          <Megaphone className="h-[18px] w-[18px]" />
        </DockLink>
      </div>
      <div className="flex flex-col items-center gap-3">
        <DockLink to="/settings" label="Settings">
          <Settings className="h-[18px] w-[18px]" />
        </DockLink>
        {user && (
          <NavLink to="/settings" title={user.fullName} aria-label={`Your profile, ${user.fullName}`}>
            <Avatar name={user.fullName} size={32} />
          </NavLink>
        )}
      </div>
    </aside>
  );
}

function DockLink({ to, label, children }: { to: string; label: string; children: ReactNode }): JSX.Element {
  return (
    <NavLink to={to} end={false} title={label} aria-label={label} className={({ isActive }) => dockLook(isActive)}>
      {children}
    </NavLink>
  );
}

/** The one look for a dock icon: a white tile when it is where you are, a quiet one when it is not. */
function dockLook(on: boolean): string {
  return cn(
    'flex h-9 w-9 items-center justify-center rounded-xl transition',
    on
      ? 'border border-slate-200/80 bg-white text-brand-600 shadow-xs dark:border-slate-700 dark:bg-slate-800 dark:text-brand-300'
      : 'text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800',
  );
}
