import { type JSX, useState } from 'react';
import {
  Copy, ListOrdered, MoreVertical, Pencil, Plus, Search, Share2, Trash2, Users,
} from 'lucide-react';
import type { CustomView } from '@ipropy/shared';
import { cn } from '../lib/utils';
import { CHOSEN } from './StatusBreakdown';

export interface PickerView extends Pick<CustomView, 'id' | 'name' | 'isSystem' | 'isPublic' | 'isDefault' | 'ownerId'> {
  isOverride?: boolean;
  count?: number;
}

/**
 * One place to choose which saved list the queue shows, and to manage them.
 *
 * **Tags left this panel on 3 October 2026**, on the owner's instruction:
 * *"also remove tag list from the dropdown of this list."* They are cards on
 * the main toolbar beside the company name now (`TagCards`), which is the one
 * place a tag is chosen — and `activeTag` is still read here, because while a
 * tag is narrowing the queue no saved list is the one in force.
 *
 * Lists are split by who owns them, because a list somebody else built is a
 * different thing from your own.
 */
export function ListPicker({
  views, activeViewId, activeTag, userId, isAdmin, moduleLabel,
  onChooseView, onEdit, onNew, onDuplicate, onShare, onDelete, onSetDefault,
}: {
  views: PickerView[];
  activeViewId: string | null;
  activeTag: string | null;
  userId: string | undefined;
  isAdmin: boolean;
  moduleLabel: string;
  onChooseView: (id: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
  onDuplicate: (id: string) => void;
  onShare: (id: string) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const matches = (name: string): boolean => !needle || name.toLowerCase().includes(needle);

  const mine = views.filter((v) => matches(v.name) && (v.isSystem || v.ownerId === userId || !v.isPublic));
  const shared = views.filter((v) => matches(v.name) && !v.isSystem && v.isPublic && v.ownerId !== userId);
  const nothing = !mine.length && !shared.length;
  const canManage = (view: PickerView): boolean =>
    Boolean(view.isSystem || view.ownerId === userId || isAdmin);

  return (
    // A size up, like the stage breakdown beside it: these are names somebody
    // reads down, not labels.
    <div className="flex max-h-[calc(100vh-11rem)] w-80 flex-col text-[13px]">
      <div className="flex items-center justify-between border-b border-slate-100 p-3 dark:border-slate-800">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Select a list</span>
        <button
          type="button"
          onClick={onNew}
          title={`New ${moduleLabel.toLowerCase()} list`}
          aria-label="Create a new list"
          className="flex h-6 w-6 items-center justify-center rounded bg-brand-600 text-white shadow-xs transition-colors hover:bg-brand-700"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="border-b border-slate-100 p-2 dark:border-slate-800">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Search for a list"
            aria-label="Search lists"
            className="input h-7 w-full pl-8 text-xs"
          />
        </div>
      </div>

      {/* A landmark, so the rows can be addressed as a set — by a screen
          reader moving between regions, and by a test that needs "the lists",
          not "every button on the page". */}
      <nav aria-label="Lists" className="flex-1 space-y-3 overflow-y-auto px-2 py-2">
        {nothing && <p className="px-1.5 py-3 text-center text-[11px] text-muted">Nothing matches “{query.trim()}”.</p>}

        {mine.length > 0 && (
          <div className="space-y-0.5">
            {mine.map((view) => (
              <ViewRow
                key={view.id}
                view={view}
                active={view.id === activeViewId && !activeTag}
                canManage={canManage(view)}
                menuOpen={menuFor === view.id}
                onToggleMenu={() => setMenuFor((current) => current === view.id ? null : view.id)}
                onChoose={() => onChooseView(view.id)}
                onEdit={() => onEdit(view.id)}
                onDuplicate={() => onDuplicate(view.id)}
                onShare={() => onShare(view.id)}
                onDelete={() => onDelete(view.id)}
                onSetDefault={() => onSetDefault(view.id)}
              />
            ))}
          </div>
        )}

        {shared.length > 0 && (
          <Section label="Shared lists">
            {shared.map((view) => (
              <ViewRow
                key={view.id}
                view={view}
                active={view.id === activeViewId && !activeTag}
                canManage={canManage(view)}
                menuOpen={menuFor === view.id}
                onToggleMenu={() => setMenuFor((current) => current === view.id ? null : view.id)}
                onChoose={() => onChooseView(view.id)}
                onEdit={() => onEdit(view.id)}
                onDuplicate={() => onDuplicate(view.id)}
                onShare={() => onShare(view.id)}
                onDelete={() => onDelete(view.id)}
                onSetDefault={() => onSetDefault(view.id)}
              />
            ))}
          </Section>
        )}

      </nav>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <span className="mb-1 block px-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ViewRow({
  view, active, canManage, menuOpen, onToggleMenu,
  onChoose, onEdit, onDuplicate, onShare, onDelete, onSetDefault,
}: {
  view: PickerView;
  active: boolean;
  canManage: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onChoose: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onShare: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}): JSX.Element {
  return (
    <div className="relative">
      <div
        className={cn(
          'flex items-center justify-between rounded-md p-2 transition-colors',
          active ? CHOSEN : 'font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800',
        )}
      >
        <button type="button" onClick={onChoose} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ListOrdered className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-brand-500' : 'text-slate-400')} />
          <span className="truncate">{view.name}</span>
          {view.isOverride && <span className="shrink-0 text-2xs text-muted" title="Your own version of this list">edited</span>}
          {typeof view.count === 'number' && (
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {view.count.toLocaleString('en-IN')}
            </span>
          )}
        </button>
        <span className="flex shrink-0 items-center gap-1.5 pl-1">
          {view.isPublic && <Users className="h-3 w-3 text-slate-400" aria-label="Shared with the team" />}
          {canManage && (
            <button
              type="button"
              aria-expanded={menuOpen}
              aria-label={`Actions for ${view.name}`}
              onClick={(e) => { e.stopPropagation(); onToggleMenu(); }}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded border transition-colors',
                menuOpen
                  ? 'border-brand-400 bg-white text-brand-600 dark:bg-slate-900'
                  : 'border-transparent text-slate-400 hover:border-slate-300 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              <MoreVertical className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>

      {/*
        **In the flow, not floating** — the owner, 3 October 2026: *"the default
        List or created list … should with function of be edit/Delete in three
        dot of the list."* Edit and Delete have always been here; the panel they
        sit in was positioned `absolute` inside a list that scrolls, and
        `overflow-y-auto` clips an absolutely-placed child — so on any row below
        the first few the menu was cut off or invisible, which reads exactly
        like the controls not existing. Opening it in the flow pushes the rows
        below down instead, and nothing can clip it.
      */}
      {menuOpen && (
        <div className="popover mx-1 mt-1 w-[calc(100%-0.5rem)] py-1">
          <MenuItem icon={<Pencil className="h-3 w-3" />} onClick={onEdit}>Edit</MenuItem>
          <MenuItem icon={<Copy className="h-3 w-3" />} onClick={onDuplicate}>Duplicate</MenuItem>
          {/* Sharing a list here is what it means in this CRM: making it public
              to the team. A list nobody else can open is not shared. */}
          {!view.isSystem && (
            <MenuItem icon={<Share2 className="h-3 w-3" />} onClick={onShare}>
              {view.isPublic ? 'Unshare' : 'Share'}
            </MenuItem>
          )}
          {!view.isSystem && (
            <MenuItem icon={<Trash2 className="h-3 w-3 text-red-400" />} danger onClick={onDelete}>Delete</MenuItem>
          )}
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <label className="flex cursor-pointer items-center gap-2 px-3 py-1 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800">
            <input
              type="checkbox"
              checked={Boolean(view.isDefault)}
              onChange={onSetDefault}
              className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-0"
            />
            <span className="select-none text-[11px] text-slate-600 dark:text-slate-300">Set as default</span>
          </label>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon, children, onClick, danger,
}: { icon: JSX.Element; children: React.ReactNode; onClick: () => void; danger?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors',
        danger
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40'
          : 'text-slate-700 hover:bg-slate-50 hover:text-brand-600 dark:text-slate-200 dark:hover:bg-slate-800',
      )}
    >
      <span className="w-4 shrink-0 text-slate-400">{icon}</span>
      {children}
    </button>
  );
}
