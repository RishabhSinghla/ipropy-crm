import type { JSX } from 'react';
import { Navigate, NavLink, Outlet, useParams } from 'react-router-dom';
import { Archive } from 'lucide-react';
import { useApp } from '../lib/store';
import { cn } from '../lib/utils';

/**
 * The Archive: Lost records, 12 hours after they went Lost, kept for good.
 *
 * **10 October 2026, the owner:** *"The archived record Save as same format of
 * module as split window and all timeline also be there as in records … The
 * archive Record we are using back in near future, so … treated archived
 * Folder as a archived module with full functioned module."*
 *
 * So this page is only a strip of module tabs over the ordinary split view
 * (`ListView` with `archive`), the same queue, record, timeline, details, call,
 * WhatsApp and notes as the module itself. Nothing here re-implements a record
 * screen. A record comes back to its module the moment its status is changed
 * away from Lost — the same save that cleared the 12-hour clock clears the
 * archive stamp.
 */
export default function ArchivePage(): JSX.Element {
  const modules = useApp((state) => state.modules).filter((module) => module.isEntity && module.permissions.view);
  const { module } = useParams<{ module?: string }>();
  if (!module && modules[0]) return <Navigate to={`/archive/${modules[0].name}`} replace />;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-white px-4 py-2 dark:bg-slate-900">
        <h1 className="mr-2 flex items-center gap-1.5 text-sm font-bold"><Archive className="h-4 w-4" /> Archive</h1>
        <nav aria-label="Archived modules" className="flex flex-wrap gap-1">
          {modules.map((item) => (
            <NavLink
              key={item.name}
              to={`/archive/${item.name}`}
              className={({ isActive }) => cn('rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                isActive ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-[var(--surface-muted)] dark:text-slate-300 dark:hover:bg-slate-800')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <p className="ml-auto text-xs text-muted">Change the status away from Lost to bring a record back to its module.</p>
      </div>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </section>
  );
}
