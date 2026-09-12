/**
 * A module, as a list you scroll — the shape of every messaging and contacts
 * app on the phone already.
 *
 * What this deliberately does not have, all of which the web list does and all
 * of which is desktop furniture: a checkbox on every row, a strip of saved-view
 * tabs, a filter builder, a column chooser, a table/kanban toggle, and a pager
 * reading "Rows per page 25, page 1 of 8". None of those is a thing a rep does
 * standing up, and together they are most of why the CRM on a phone felt like a
 * website rather than an app.
 *
 * What replaces them: search, scroll, and swipe. Saved views are still here —
 * they are a real feature somebody configured — but as a quiet chip row rather
 * than a tab bar, and only when more than one exists.
 *
 * The rows themselves are built from metadata, not from a hardcoded idea of
 * what a lead looks like. The module's own list columns decide the second line,
 * so a field renamed in the admin panel reaches this screen with no release.
 */
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { FieldMeta, RecordEnvelope } from '@ipropy/shared';
import { MessageCircle, Phone, Plus, Search as SearchIcon, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useOfflineList, useOfflineMeta } from '../lib/useOfflineList';
import { cn } from '../lib/utils';
import { dial, openExternal } from '../lib/nativeActions';
import { useSwipeActions, type SwipeSide } from '../lib/swipeActions';
import { Spinner } from '../components/ui';
import { AppBar, Avatar, Fab, Row } from './primitives';
import { phoneOf, secondLine, shortTime } from './rows';

const PAGE_SIZE = 30;

export default function MobileList(): JSX.Element {
  const { module = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const user = useApp((s) => s.user);

  const [searchOpen, setSearchOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const viewId = params.get('view') ?? undefined;

  // 250ms. Long enough that typing a name is one request rather than nine,
  // short enough that it still feels like the list is following you.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(term.trim()), 250);
    return () => window.clearTimeout(t);
  }, [term]);

  const { data: liveMeta } = useQuery({
    queryKey: ['module', module],
    queryFn: () => api.module(module),
    staleTime: 5 * 60_000,
  });

  /*
    A list cannot render without knowing its own fields, so an unreachable
    server leaves this screen blank however many records are cached. Field
    labels and types change when an admin edits them, not minute to minute, so
    an hour-old copy showing a real record is a far better answer than nothing.
  */
  const meta = useOfflineMeta(module, liveMeta, user?.id);

  const { data: views } = useQuery({
    queryKey: ['views', module],
    queryFn: () => api.views(module),
    staleTime: 5 * 60_000,
  });

  const list = useInfiniteQuery({
    queryKey: ['mobile-list', module, viewId, debounced],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api.list(module, {
      page: pageParam,
      pageSize: PAGE_SIZE,
      ...(viewId ? { view: viewId } : {}),
      ...(debounced ? { search: debounced } : {}),
    }),
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });

  /*
    The last list this person saw, handed back when the request actually fails.

    Not `navigator.onLine` — that reports whether the device has a network
    interface, not whether anything is reachable through it, and the case this
    exists for (one bar in the basement of a half-built floor) reports online
    while every request times out.

    Only the plain first page is remembered, so a search or a saved view never
    answers out of the cache — showing a remembered unfiltered list to somebody
    who searched for a name would answer a question they did not ask.
  */
  const offline = useOfflineList(
    module,
    { page: 1, pageSize: PAGE_SIZE, ...(viewId ? { view: viewId } : {}), ...(debounced ? { search: debounced } : {}) },
    list.data?.pages[0],
    user?.id,
    list.isError,
  );

  const rows = useMemo(
    () => (list.data ? list.data.pages.flatMap((p) => p.rows) : offline.rows),
    [list.data, offline.rows],
  );
  const total = list.data?.pages[0]?.total ?? 0;

  const fields = useMemo(() => {
    const map = new Map<string, FieldMeta>();
    for (const f of meta?.fields ?? []) map.set(f.name, f);
    return map;
  }, [meta]);

  /*
    Scroll to the end and the next page loads. No button, no page numbers.
    `rootMargin` fires it a screen early, so on a decent connection the list
    never actually stops — which is the difference between "fast" and "fast
    once you have waited".
  */
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && list.hasNextPage && !list.isFetchingNextPage) {
        void list.fetchNextPage();
      }
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage, list]);

  const label = meta?.label ?? '';

  const closeSearch = useCallback(() => { setSearchOpen(false); setTerm(''); }, []);

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]">
      {searchOpen ? (
        <header className="sticky top-0 z-20 shrink-0 bg-[var(--surface)]/95 px-3 py-2 backdrop-blur-xl">
          <div className="flex items-center gap-2 rounded-full bg-slate-500/10 px-3">
            <SearchIcon className="h-4 w-4 shrink-0 text-muted" />
            <input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}`}
              className="h-11 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted"
              // `search` puts a magnifier on the keyboard instead of a return
              // key, which is what the rest of the phone does here.
              type="search"
              enterKeyHint="search"
            />
            <button type="button" onClick={closeSearch} aria-label="Close search" className="p-1 text-muted">
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>
      ) : (
        <AppBar
          large
          title={label}
          subtitle={total ? `${total.toLocaleString('en-IN')}` : undefined}
          actions={(
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Search"
              className="flex h-11 w-11 items-center justify-center rounded-full text-slate-600 active:bg-slate-500/10 dark:text-slate-300"
            >
              <SearchIcon className="h-5 w-5" />
            </button>
          )}
        />
      )}

      {/*
        Saved views, only when somebody has made one. A single "All" chip is a
        control that cannot be used, and a row of tabs above every list is the
        web app's habit, not a phone's.
      */}
      {(views?.length ?? 0) > 1 && !searchOpen && (
        <div className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(views ?? []).map((v) => {
            const active = viewId ? v.id === viewId : Boolean(v.isDefault);
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set('view', v.id);
                  setParams(next, { replace: true });
                }}
                className={cn(
                  'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors',
                  active
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
                )}
              >
                {v.name}
              </button>
            );
          })}
        </div>
      )}

      {/*
        Said plainly, and only when it is true. A remembered list passed off as
        the current one is worse than no list: a rep would ring somebody whose
        stage changed an hour ago and not know it.
      */}
      {offline.stale && (
        <div className="shrink-0 bg-amber-50 px-4 py-2 text-[13px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          No connection — showing what was here {offline.asOf}.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {list.isPending && !offline.rows.length ? (
          <div className="flex h-40 items-center justify-center"><Spinner className="h-6 w-6 text-brand-600" /></div>
        ) : rows.length === 0 ? (
          <div className="px-8 pt-20 text-center">
            <p className="text-[17px] font-medium">
              {debounced ? 'Nothing found' : `No ${label.toLowerCase()} yet`}
            </p>
            <p className="mt-1 text-[15px] text-muted">
              {debounced ? 'Try a different name or number.' : 'Tap + to add the first one.'}
            </p>
          </div>
        ) : (
          <div className="bg-[var(--surface)]">
            {rows.map((row) => (
              <ListRow
                key={row.id}
                row={row}
                fields={fields}
                pipelineField={meta?.pipelineField ?? null}
                onOpen={() => navigate(`/${module}/${row.id}`)}
              />
            ))}
            <div ref={sentinel} />
            {list.isFetchingNextPage && (
              <div className="flex justify-center py-6"><Spinner className="h-5 w-5 text-brand-600" /></div>
            )}
          </div>
        )}
        {/* Clears the tab bar and the floating button. */}
        <div style={{ height: 'calc(var(--bottom-nav-h, 0px) + 88px)' }} />
      </div>

      <Fab label={`Add ${label.toLowerCase()}`} icon={<Plus className="h-6 w-6" />} onClick={() => navigate(`/${module}/new`)} />
    </div>
  );
}

/**
 * One record.
 *
 * Swipe right to call, left to open WhatsApp — the Gmail gesture, and the one
 * the owner asked for on the web list. It is armed only once the row has
 * travelled far enough to be deliberate, so scrolling never rings anybody.
 */
function ListRow({
  row, fields, pipelineField, onOpen,
}: {
  row: RecordEnvelope;
  fields: Map<string, FieldMeta>;
  pipelineField: string | null;
  onOpen: () => void;
}): JSX.Element {
  const phone = phoneOf(row, fields);

  const { handlers, state } = useSwipeActions((side: SwipeSide) => {
    if (!phone) return;
    if (side === 'right') dial(phone);
    else void openExternal(`https://wa.me/${phone.replace(/[^\d+]/g, '')}`);
  }, Boolean(phone));

  return (
    <div className="relative overflow-hidden">
      {/*
        What is revealed underneath as the row moves. Green for the call side
        and the WhatsApp side both, because that is the colour a rep already
        associates with both actions on this phone.
      */}
      {state.dx !== 0 && phone && (
        <div
          className={cn(
            'absolute inset-0 flex items-center px-6 text-white',
            state.dx > 0 ? 'justify-start bg-emerald-600' : 'justify-end bg-emerald-700',
          )}
        >
          {state.dx > 0 ? <Phone className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
        </div>
      )}

      <div
        {...handlers}
        className="relative bg-[var(--surface)]"
        style={{ transform: `translateX(${state.dx}px)` }}
      >
        <Row
          onClick={onOpen}
          leading={<Avatar name={row.label} />}
          title={row.label}
          subtitle={secondLine(row, fields, pipelineField) || undefined}
          trailing={<span className="text-[12px] text-muted">{shortTime(row.updatedAt)}</span>}
          className="border-b border-[var(--border)]"
        />
      </div>
    </div>
  );
}

