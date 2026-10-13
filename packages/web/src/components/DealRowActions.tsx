/**
 * What can be done to one row of an Associate's deal table: Edit, View the whole
 * message, Duplicate, Matching (with how many of our own records the deal fits),
 * Compare, Open in Dealer groups, Copy details and Delete.
 *
 * All of it sits behind one three-dot button. The row used to show eight icons
 * and buttons in a line, which took the space the facts in the row needed — the
 * owner, 13 October 2026: *"move them into the right three dots … it gives us more
 * space"*.
 *
 * It decides nothing — every press is handed back to the table, which owns the
 * data. That is what lets the same actions act on one row or on a ticked few.
 */
import { type JSX } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Eye, MoreHorizontal, Pencil, Scale, Sparkles, Trash2 } from 'lucide-react';
import type { DealerDeal } from '../lib/api';
import { Dropdown, DropdownItem } from './ui';

const TRIGGER = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--surface-muted)] hover:text-brand-700 dark:hover:text-brand-300';
const LINK_ROW = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800';

export interface RowActionHandlers {
  onEdit: () => void;
  onView: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onCompare: () => void;
  onCopy: () => void;
}

/** `matchCount` is `undefined` while the counts are still loading, so the menu shows a dash and not a false zero. */
export function DealRowActions({ deal, matchCount, handlers }: { deal: DealerDeal; matchCount: number | undefined; handlers: RowActionHandlers }): JSX.Element {
  return (
    <div className="flex items-center justify-end" data-testid="deal-actions" onClick={(event) => event.stopPropagation()}>
      <Dropdown trigger={<button type="button" title="Actions" aria-label="Actions for this property" data-testid="deal-more" className={TRIGGER}><MoreHorizontal className="h-4 w-4" /></button>}>
        {(close) => (
          <div className="min-w-[13rem] py-1">
            <DropdownItem testId="deal-edit" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { close(); handlers.onEdit(); }}>Edit</DropdownItem>
            <DropdownItem testId="deal-view" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => { close(); handlers.onView(); }}>View full message</DropdownItem>
            <DropdownItem testId="deal-duplicate" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => { close(); handlers.onDuplicate(); }}>Duplicate</DropdownItem>
            <Link to={`/market?deal=${deal.postId}`} onClick={close} data-testid="deal-matching" title="Which of our own records this fits" className={LINK_ROW}>
              <Sparkles className="h-3.5 w-3.5" />
              Matching
              <span className="ml-auto rounded-full bg-brand-600 px-1.5 text-[10px] leading-4 text-white" data-testid="deal-match-count">{matchCount ?? '–'}</span>
            </Link>
            <DropdownItem testId="deal-compare" icon={<Scale className="h-3.5 w-3.5" />} onClick={() => { close(); handlers.onCompare(); }}>Compare</DropdownItem>
            <DropdownItem onClick={() => { close(); handlers.onCopy(); }}>Copy details</DropdownItem>
            <div className="my-1 border-t border-[var(--border)]" />
            <DropdownItem testId="deal-delete" danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => { close(); handlers.onDelete(); }}>Delete</DropdownItem>
          </div>
        )}
      </Dropdown>
    </div>
  );
}
