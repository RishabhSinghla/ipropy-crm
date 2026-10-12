/**
 * The buttons at the end of one row of an Associate's deal table: Edit, View,
 * Duplicate, Delete, a Matching button that says how many of our own records the
 * deal fits, Compare, and a three-dot menu for the rest.
 *
 * It decides nothing — every press is handed back to the table, which owns the
 * data. That is what lets the same buttons act on one row or on a ticked few.
 */
import { type JSX } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Eye, MoreHorizontal, Pencil, Scale, Sparkles, Trash2 } from 'lucide-react';
import type { DealerDeal } from '../lib/api';
import { Dropdown, DropdownItem } from './ui';
import { cn } from '../lib/utils';

const ICON_BUTTON = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--surface-muted)] hover:text-brand-700 dark:hover:text-brand-300';

export interface RowActionHandlers {
  onEdit: () => void;
  onView: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onCompare: () => void;
  onCopy: () => void;
}

function IconButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={`${label} this property`}
      data-testid={`deal-${label.toLowerCase()}`}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={cn(ICON_BUTTON, danger && 'hover:text-negative dark:hover:text-negative')}
    >
      {children}
    </button>
  );
}

/** `undefined` while the counts are still loading, so the button shows a dash and not a false zero. */
export function DealRowActions({ deal, matchCount, handlers }: { deal: DealerDeal; matchCount: number | undefined; handlers: RowActionHandlers }): JSX.Element {
  return (
    <div className="flex items-center gap-0.5 whitespace-nowrap" data-testid="deal-actions">
      <IconButton label="Edit" onClick={handlers.onEdit}><Pencil className="h-3.5 w-3.5" /></IconButton>
      <IconButton label="View" onClick={handlers.onView}><Eye className="h-3.5 w-3.5" /></IconButton>
      <IconButton label="Duplicate" onClick={handlers.onDuplicate}><Copy className="h-3.5 w-3.5" /></IconButton>
      <IconButton label="Delete" onClick={handlers.onDelete} danger><Trash2 className="h-3.5 w-3.5" /></IconButton>
      <Link
        to={`/market?deal=${deal.postId}`}
        onClick={(event) => event.stopPropagation()}
        title="Which of our own records this fits"
        data-testid="deal-matching"
        className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-[11px] font-semibold text-brand-700 hover:bg-[var(--surface-muted)] dark:text-brand-300"
      >
        <Sparkles className="h-3 w-3" />
        Matching
        <span className="rounded-full bg-brand-600 px-1.5 text-[10px] leading-4 text-white" data-testid="deal-match-count">{matchCount ?? '–'}</span>
      </Link>
      <IconButton label="Compare" onClick={handlers.onCompare}><Scale className="h-3.5 w-3.5" /></IconButton>
      <span onClick={(event) => event.stopPropagation()}>
        <Dropdown trigger={<button type="button" title="More" aria-label="More actions for this property" data-testid="deal-more" className={ICON_BUTTON}><MoreHorizontal className="h-4 w-4" /></button>}>
          {(close) => (
            <div className="min-w-[12rem] py-1">
              <DropdownItem onClick={() => { close(); handlers.onView(); }}>Read full message</DropdownItem>
              <Link to={`/market?deal=${deal.postId}`} onClick={close} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">Open in Dealer groups</Link>
              <DropdownItem onClick={() => { close(); handlers.onCopy(); }}>Copy details</DropdownItem>
            </div>
          )}
        </Dropdown>
      </span>
    </div>
  );
}
