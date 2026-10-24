/**
 * A drop-down for choosing one thing from a list, with a search box at the top.
 *
 * The call sheet's filters (type, BHK, sale or rent, status) and the same filters on the Market feed and the dealers'
 * deal tables used the browser's own `<select>`, which cannot hold a search box. This replaces it wherever those
 * filters appear, so one control behaves one way everywhere.
 *
 * Typing narrows the list to every option whose label *or* hidden `keywords` contain what was typed (case and spacing
 * ignored), so an option can be found by a name, a number, a project or a group it stands for. It works with the keyboard
 * (the search box is focused on open; arrows move, Enter chooses, Escape closes and hands focus back) and on a phone
 * (the search box is 16px so iOS does not zoom, rows are tall enough to tap, the panel never leaves the screen).
 */
import { type JSX, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { filterOptions, moveHighlight, type SelectOption } from '../lib/searchOptions';

export default function SearchableSelect({ value, onChange, options, ariaLabel, className, fullWidth, searchPlaceholder = 'Search…' }: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  className?: string;
  /** Fill the cell it sits in, as a table's filter row needs. */
  fullWidth?: boolean;
  searchPlaceholder?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const shown = useMemo(() => filterOptions(options, search), [options, search]);
  const chosen = options.find((option) => option.value === value);

  const close = (): void => { setOpen(false); setSearch(''); triggerRef.current?.focus(); };
  const choose = (option: SelectOption): void => { onChange(option.value); close(); };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const outside = (event: MouseEvent | TouchEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) { setOpen(false); setSearch(''); }
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('touchstart', outside);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('touchstart', outside); };
  }, [open]);

  // A new search starts at its first match; opening starts on the option already chosen.
  useEffect(() => setHighlight(0), [search]);
  useEffect(() => {
    if (open) setHighlight(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${highlight}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, highlight, listId]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((h) => moveHighlight(h, 1, shown.length)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((h) => moveHighlight(h, -1, shown.length)); }
    else if (event.key === 'Enter') { event.preventDefault(); const pick = shown[highlight]; if (pick) choose(pick); }
    else if (event.key === 'Tab') { setOpen(false); setSearch(''); }
  };

  return (
    <div className={cn('relative', fullWidth ? 'block w-full' : 'inline-block')} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={cn('input flex items-center justify-between gap-2 text-left', fullWidth ? 'w-full' : 'w-auto', className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); } }}
      >
        <span className="truncate">{chosen?.label ?? ''}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
      </button>
      {open && (
        <div className="popover absolute left-0 z-40 mt-1 w-64 max-w-[calc(100vw-2rem)] overflow-hidden" onKeyDown={onKeyDown}>
          <div className="relative border-b border-[var(--border)] p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={shown[highlight] ? `${listId}-${highlight}` : undefined}
              aria-label={`Search ${ariaLabel}`}
              placeholder={searchPlaceholder}
              autoComplete="off"
              className="input w-full pl-8 text-base sm:text-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <ul id={listId} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto py-1">
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-muted" role="presentation">Nothing matches “{search}”</li>}
            {shown.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={cn(
                  'flex min-h-10 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm sm:min-h-0 sm:py-1.5',
                  index === highlight && 'bg-[var(--surface-muted)]',
                  option.value === value && 'font-semibold',
                )}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => choose(option)}
              >
                <span className="truncate">{option.label}</span>
                {option.value === value && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
