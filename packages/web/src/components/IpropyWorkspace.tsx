import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SummaryText } from './SummaryText';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { recordStrength, relativeTime, type FieldMeta, type RecordEnvelope } from '@ipropy/shared';
import {
  ArrowRightLeft, ArrowUpDown, Check, ChevronLeft, ChevronRight, FileText, GripVertical,
  History, Mail, MessageCircle, MessageSquare, MessagesSquare, MoreHorizontal, Phone, Search, Send,
  Sparkles, Star, Tag, Trash2, Users, X,
} from 'lucide-react';
import { CallButton, CallDispositionProvider } from './CallDisposition';
import { WhatsAppComposerProvider } from './WhatsAppComposer';
import { MatchingTab } from './MatchingTab';
import { WhatsAppTab } from './WhatsAppTab';
import { WhatsAppButton } from './WhatsAppButton';
import { TagButton, TagChips } from './TagButton';
import { CallsTab, FilesTab } from '../pages/RecordDetail';
import ComposeModal from './ComposeModal';
import { EditableField, isInlineEditable } from './EditableField';
import { NoteComposer } from './RecordBlocks';
import { ActivityFeed, FEED_LIMIT, useActivityEntries } from './ActivityFeed';
import { RecordInspector } from './RecordInspector';
import { AccessRequestBanner } from './AccessRequestBanner';
import { CallDeckPanel, useCallIsOn } from './CallDeckPanel';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import { cardArea, cardPrice, oneOfEach, queueCardFields, unitDescription, type CardFields } from '../lib/queueCard';
import { invalidateRecordQueries } from '../lib/invalidate';
import { ModuleIcon } from './Layout';
import { Avatar, ConfirmDialog, Dropdown, DropdownItem, Modal, Spinner } from './ui';
import { ACTION_CIRCLE } from '../lib/actionCircle';
import { RecordAvatar, StrengthBar } from './RecordAvatar';
import {
  ON_THE_BAR, activityKindOf, arrangeRecordMenu, loadRecordMenu, moveEntry, saveRecordMenu, splitMenu,
  type MenuKey,
} from '../lib/recordMenu';
import { api } from '../lib/api';
import { activeSortOption, sortOptions } from '../lib/listSort';
import { cn } from '../lib/utils';
import { toast } from '../lib/store';
import { queueRecordUrl } from '../lib/saveNextUrl';
import { ProgressiveDialerPanel } from './ProgressiveDialerPanel';

/*
  **2 October 2026, the owner:** *"all tab of activity move/merge in to menu
  bar i.e All, Comment, Messages, Calls, Changes, Files."*

  One row of buttons now. Five of them open a screen of their own; three narrow
  the activity stream to one kind of thing that happened. What each one *is*
  lives in `lib/recordMenu.ts`, pure and tested — this file only draws it.
*/
const MENU_ICON: Record<MenuKey, JSX.Element> = {
  timeline: <MessagesSquare className="h-4 w-4" />,
  matching: <Users className="h-4 w-4" />,
  files: <FileText className="h-4 w-4" />,
  calls: <Phone className="h-4 w-4" />,
  whatsapp: <MessageCircle className="h-4 w-4" />,
  comment: <MessageSquare className="h-4 w-4" />,
  message: <Send className="h-4 w-4" />,
  audit: <History className="h-4 w-4" />,
};

/** The three the activity stream contributes. Tab labels stay the Layout Designer's. */
/*
  **"Note", not "Comments"** — the owner, 3 October 2026: *"Please change the
  Name of Comment to Note."* It is what the box at the foot of the record has
  always called itself ("Write a note…"), and one thing with two names is one
  thing a rep has to learn twice.
*/
const STREAM_LABEL: Record<'comment' | 'message' | 'audit', string> = {
  comment: 'Notes',
  message: 'Messages',
  audit: 'Changes',
};

/**
 * The module as the list itself has it: fields, the layout an admin arranged,
 * and the two things writing needs — what this profile may do, and which
 * picklist narrows which.
 */
/*
  Where the divider sits, remembered in the browser.

  The same reasoning as which view a list opens in: it is a personal
  preference somebody adjusts several times a day, it is nobody else's
  business, and a per-user setting needing a round trip to say how wide you
  like your queue is slow at exactly the wrong moment.

  One divider, not two. The owner's instruction on 19 September: "we work only
  in two split panes in future" — the notes moved beside Basic Information,
  where a note is written about what is on screen rather than in a third
  column competing with it for width.
*/
const SPLIT_KEY = 'ipropy.split';
const QUEUE_LIMITS = [240, 620] as const;

function loadSplit(fallback: number): number {
  const [min, max] = QUEUE_LIMITS;
  try {
    const raw = Number(localStorage.getItem(`${SPLIT_KEY}.queue`));
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.min(max, Math.max(min, raw));
  } catch {
    // A private window and blocked site data both throw here, and a divider
    // that cannot be remembered is not a reason for a blank screen.
    return fallback;
  }
}

/**
 * The grip between the queue and the record.
 *
 * Pointer events rather than mouse events, so the same handler answers a
 * finger on a tablet — which is where this view gets used, standing in a site
 * office. The pointer is captured on the handle, so a fast drag that outruns
 * the cursor does not let go halfway across the screen.
 *
 * Arrow keys move it too. A divider that only answers a mouse is one that
 * somebody working from the keyboard cannot move at all.
 */
function SplitHandle({ label, width, onDrag }: { label: string; width: number; onDrag: (deltaX: number) => void }): JSX.Element {
  const from = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      // A separator you can focus is a control, and a control says where it
      // is: without these a screen reader announces a divider it cannot place.
      aria-valuenow={width}
      aria-valuemin={QUEUE_LIMITS[0]}
      aria-valuemax={QUEUE_LIMITS[1]}
      tabIndex={0}
      className="group relative hidden w-px shrink-0 cursor-col-resize touch-none bg-slate-200 transition-colors hover:w-1 hover:bg-brand-400 focus:w-1 focus:bg-brand-400 focus:outline-none dark:bg-slate-800 xl:block"
      onPointerDown={(event) => {
        from.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const delta = event.clientX - from.current;
        from.current = event.clientX;
        onDrag(delta);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); onDrag(-24); }
        if (event.key === 'ArrowRight') { event.preventDefault(); onDrag(24); }
      }}
    >
      <span className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}


/**
 * The split view: the queue on the left, the whole record beside it — and
 * **nothing that sends you anywhere else**.
 *
 * That is the owner's instruction on 19 September, and it is the shape of the
 * job: a rep works a list, and every trip to another page is a trip back. So
 * there is no Edit button, no "open the full record" button and no dialog.
 * Everything the record page shows is here, and every value is typed in where
 * it stands.
 *
 * Two things it needs that a list row cannot give:
 *
 *  * **the whole record.** A list row carries only the values the *list* asked
 *    for, so a field that is not a column read back blank — which is exactly
 *    why Contact Type was missing from the header. The open record is fetched
 *    by id, on the key the record page already uses.
 *  * **who owns it.** `ownerName` is filled in by nothing except the phone
 *    app's caller lookup, so this header said "Unassigned" on every record
 *    however it was assigned. The assignment field is drawn the way the record
 *    page draws it — found by uitype, shown by its display value, edited in
 *    place, and sitting between the name and when it was last touched.
 */
export function IpropyWorkspace({
  module, rows, selected, onToggleSelect, onToggleAll, onDelete,
  openId, sortBy, sortDir, neighbourContext, callQueueUrl, onSort,
  queueTools, queueFooter, filterBar, onShowing,
}: {
  module: DescribedModule; rows: RecordEnvelope[];
  selected: Set<string>; onToggleSelect: (id: string, checked: boolean) => void;
  /** Tick every row on this page, for the bulk-edit bar the list already has. */
  onToggleAll?: (checked: boolean) => void;
  /** Absent when this profile may not delete — the button is not offered at all. */
  onDelete?: (row: RecordEnvelope) => void;
  /**
   * A record to open straight away, named in the address as `?open=`.
   *
   * It may not be in the queue at all — global search reaches all 22,981
   * contacts and the queue is one page of fifty — so the pane fetches it by id
   * rather than looking for it among the rows.
   */
  openId?: string | null;
  /** The list's own ordering, so the queue's menu drives the same query the table does. */
  sortBy?: string; sortDir?: 'asc' | 'desc';
  /** The active list's filters, so record navigation follows the queue in view. */
  neighbourContext?: { view?: string; search?: string; filter?: string };
  /** Snapshot of the effective queue, including unsaved quick-filter choices. */
  callQueueUrl: string;
  onSort?: (by: string | undefined, dir: 'asc' | 'desc') => void;
  /**
   * The list's own filter chips and search, drawn under the queue's header.
   *
   * **30 September 2026, the owner's prototype:** *"the list of All Leads,
   * Status, Call Log etc button move to Below Filter & Sorting Icons of Left
   * pane"*. They stay the list's components — they filter the query the list
   * sends — and this pane only gives them a place.
   */
  queueTools?: ReactNode;
  /** The record range and the page arrows, at the foot of the queue. */
  queueFooter?: ReactNode;
  /**
   * Whether the list's quick filters are on, how to open or clear them, and
   * the panel itself — drawn inside the right-hand pane, in its exact shape.
   */
  /** The Quick & Live Filters panel, drawn in the right pane; `open` unfolds a folded pane while it shows. */
  filterBar?: { open: boolean; panel?: ReactNode; onToggle?: () => void };
  /**
   * Which pane a small screen is on — so the page around this one can get out
   * of the way. The list's phone pager is the caller: it belongs to the list,
   * and on a phone the list is not on screen while a record is open.
   */
  onShowing?: (showing: 'list' | 'record') => void;
}): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(openId ?? rows[0]?.id ?? null);
  const [menuPick, setMenuPick] = useState<MenuKey | null>(null);
  const [finding, setFinding] = useState(false);
  const [findText, setFindText] = useState('');
  const [queueWidth, setQueueWidth] = useState(() => loadSplit(360));

  /*
    Which pane a small screen is showing.

    **2 October 2026, the owner:** *"I want to make it as simple as GMAIL /
    WhatsApp App … we can use Web app, Safari app, Android app in same
    format."*

    That is one pattern, not three designs: a list, you tap a row, the record
    fills the screen, you come back. On a wide screen both sit side by side —
    which is the same pattern with room for both, and is what Gmail does too.

    Below `xl` the two panes used to **stack**, so a phone had to scroll past
    fifty records to reach the one it had opened. Both stay mounted and one is
    hidden, never unmounted: a remount would lose the queue's scroll position
    and refetch the record every time somebody pressed Back.
  */
  const [showing, setShowing] = useState<'list' | 'record'>('list');
  useEffect(() => { onShowing?.(showing); }, [showing, onShowing]);
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  /*
    How tall the two panes are, measured rather than guessed.

    It used to be `calc(100vh - 13rem)`, a stand-in for whatever the toolbar
    above happens to be — and it was about a hundred pixels out, which is the
    white gap under the queue the owner reported. Reading the shell's own
    distance from the top of the page is exact, and it stays exact when the
    toolbar above grows a row.
  */
  const shell = useRef<HTMLDivElement>(null);

  /*
    The header's field strip is **one row, always**, and says so when it cannot
    fit: *"Please set all in one row, so that we can see narrow header and wide
    Timeline… if more then line should make it in dash … so that we can choose
    only option from master."*

    Wrapping was the old behaviour, and a header that grows to two or three
    rows eats the screen the work happens on. Clipping alone would hide fields
    silently, so the row is measured and a `…` appears when something is out of
    sight — the cue to arrange fewer of them in the Layout Designer. That
    measuring lives in `HeaderFieldStrip` now, shared with the Chats header.
  */
  const [paneTop, setPaneTop] = useState(0);
  useEffect(() => {
    const measure = (): void => {
      const box = shell.current?.getBoundingClientRect();
      if (box) setPaneTop(Math.round(box.top + window.scrollY));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);


  const star = useMutation({
    mutationFn: (row: RecordEnvelope) => api.star(module.name, row.id, !row.starred),
    /*
      **With the record's id.** Without it `invalidateRecordQueries` refreshes
      the lists and leaves `['record', module, id]` alone — and this header
      reads the *fetched record*, not the list row. So the star saved, the
      queue knew, and the button somebody had just pressed stayed exactly as it
      was until something else happened to refetch. That is the whole of
      "favourite does not work properly in split view".
    */
    onSuccess: (_result, row) => invalidateRecordQueries(queryClient, module.name, row.id),
    onError: (error: Error) => toast.error('Could not change that', error.message),
  });
  // Somebody arriving on a link that names a record: open that one.
  useEffect(() => { if (openId) setActiveId(openId); }, [openId]);
  /*
    Keep the open record when the queue changes under it — **including one that
    is not in the queue at all.** A record reached from global search or from a
    chat is almost never on the fifty rows showing, and without that second
    condition the pane snapped back to the first row the moment the list
    refreshed.
  */
  useEffect(() => setActiveId((current) => (
    current && (current === openId || rows.some((row) => row.id === current))
      ? current
      : (rows[0]?.id ?? null)
  )), [rows, openId]);

  const listRow = rows.find((row) => row.id === activeId) ?? (activeId ? null : rows[0] ?? null);

  const { data: fetched, isError: notThere } = useQuery({
    queryKey: ['record', module.name, activeId],
    queryFn: () => api.record(module.name, activeId!),
    enabled: Boolean(activeId),
    retry: false,
  });
  /*
    A link naming a record that is gone, or never existed — a stale bookmark, a
    deleted lead, a mistyped address. Without this the pane sat empty with a
    queue full of records beside it, which reads as the screen being broken
    rather than as one link being wrong.
  */
  useEffect(() => {
    if (notThere) setActiveId(rows[0]?.id ?? null);
  }, [notThere, rows]);
  // The row stands in while the record loads, so the pane never blanks between
  // two selections. Its values are right, there are simply fewer of them.
  const active = fetched && fetched.id === activeId ? fetched : listRow;
  // A search belongs to the record it was typed on.
  useEffect(() => { setFindText(''); setFinding(false); }, [activeId]);

  const { data: neighbours } = useQuery({
    queryKey: ['record-neighbours', module.name, activeId, neighbourContext, sortBy, sortDir],
    queryFn: () => api.neighbours(module.name, activeId!, {
      ...neighbourContext,
      ...(sortBy ? { sort: sortBy } : {}),
      ...(sortDir ? { dir: sortDir } : {}),
    }),
    enabled: Boolean(activeId),
    staleTime: 15_000,
  });
  const navigate = useNavigate();
  const openRecord = useCallback((id: string) => {
    setActiveId(id);
    // On a phone this is the whole navigation: the record takes the screen.
    // On a wide screen nothing moves, because both panes are always drawn.
    setShowing('record');
    const next = new URLSearchParams(window.location.search);
    next.set('open', id);
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);

  /*
    Up and down arrows move through the queue, the way they move through
    chats in WhatsApp (the owner, 2 October 2026). Not while somebody is
    typing, and not while a dialog or a menu is open — there the arrows belong
    to what has the focus.
  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTypingOrInAPopup(event.target)) return;
      const at = rows.findIndex((row) => row.id === activeId);
      const next = rows[event.key === 'ArrowDown' ? at + 1 : at - 1];
      if (!next) return;
      event.preventDefault();
      openRecord(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, activeId, openRecord]);
  /*
    A move that lands on a different page of the queue.

    Never `window.location.assign`: that reloads the whole CRM, which is what
    the owner reported on 28 September 2026 about Save & next. The destination
    is usually the same `/leads` route with a different page, and React Router
    keeps one `ListView` mounted across that — so the stamp tells `ListRoute`
    in `App.tsx` to remount, which hydrates the new page exactly as a reload
    did and downloads nothing.
  */
  const goToPage = useCallback((url: string) => {
    navigate(url, { state: { callDeckHandoff: Date.now() } });
  }, [navigate]);

  const openNeighbour = useCallback((id: string, estimatedPosition: number) => {
    if (rows.some((row) => row.id === id)) {
      openRecord(id);
      return;
    }
    // Crossing a page boundary needs both a new page and a new open record.
    // Re-read the destination's ordinal because another rep may have edited
    // the queue since the current record's neighbours were fetched.
    void api.neighbours(module.name, id, {
      ...neighbourContext,
      ...(sortBy ? { sort: sortBy } : {}),
      ...(sortDir ? { dir: sortDir } : {}),
    }).then(({ position }) => {
      goToPage(queueRecordUrl(callQueueUrl, module.name, id, position ?? estimatedPosition));
    }).catch(() => {
      goToPage(queueRecordUrl(callQueueUrl, module.name, id, estimatedPosition));
    });
  }, [rows, openRecord, module.name, neighbourContext, sortBy, sortDir, callQueueUrl, goToPage]);

  /*
    **Folded on arrival, every time** — the owner, 3 October 2026: *"the Right
    Pane Detail Form Window are by the default close, when we Refresh or Login
    to CRM, if we need i will open it."*

    So this is deliberately **not** remembered, unlike the divider's width.
    Opening it is a decision about the record in front of you, not a standing
    preference, and a pane that reopens itself on every sign-in is the thing he
    asked to be rid of. It stays open for as long as the tab is, and a refresh
    starts clean. The old stored key is left alone: nothing reads it, so
    bringing this back is code rather than data recovery.
  */
  const [paneFolded, setPaneFoldedState] = useState(true);
  const setPaneFolded = useCallback((folded: boolean) => setPaneFoldedState(folded), []);

  const resize = useCallback((delta: number) => {
    const [min, max] = QUEUE_LIMITS;
    setQueueWidth((current) => {
      const next = Math.min(max, Math.max(min, current + delta));
      try { localStorage.setItem(`${SPLIT_KEY}.queue`, String(Math.round(next))); } catch { /* see loadSplit */ }
      return next;
    });
  }, []);

  /*
    Which fields this module's panes show — the Layout Designer's
    arrangement, then the Layout Designer's, then the module's own flags.

    One hook, because the WhatsApp Chats screen shows the same record beside a
    conversation and must reach the same answer. A second copy of this
    reasoning is the mistake this repo keeps finding months later.
  */
  const {
    queueFields, blocks, tabs, rightPaneRows,
    assignedField, statusField, followUpField, phoneField, emailField,
  } = useRecordPanes(module);
  /*
    The menu bar's order, this browser's own.

    It is remembered per person per module rather than per organisation — the
    owner asked for *"user can set menu button … as per their priority"*, and a
    rep who lives in Comments and a manager who lives in Changes are both
    right. Same reasoning as which view a list opens in and how wide the queue
    is: a personal arrangement, adjusted now and then, nobody else's business.
  */
  const [savedMenu, setSavedMenu] = useState<MenuKey[] | null>(() => loadRecordMenu(module.name));
  useEffect(() => { setSavedMenu(loadRecordMenu(module.name)); }, [module.name]);
  const availableMenu = useMemo<MenuKey[]>(
    () => [...tabs.filter((item) => item.key !== 'timeline').map((item) => item.key as MenuKey), 'comment', 'message', 'audit'],
    [tabs],
  );
  const menuOrder = useMemo(() => arrangeRecordMenu(availableMenu, savedMenu), [availableMenu, savedMenu]);
  const reorderMenu = useCallback((from: number, to: number) => {
    // Outside the state updater on purpose: StrictMode calls an updater twice,
    // and a write to storage is not something to do twice for one drag.
    const next = moveEntry(menuOrder, from, to);
    saveRecordMenu(module.name, next);
    setSavedMenu(next);
  }, [menuOrder, module.name]);
  const menuLabel = useCallback((key: MenuKey): string => {
    const kind = activityKindOf(key);
    if (kind) return STREAM_LABEL[kind];
    return tabs.find((item) => item.key === key)?.label ?? key;
  }, [tabs]);

  // Nothing picked yet, or an entry the designer has since hidden: the first one.
  const shownKey: MenuKey = menuOrder.includes(menuPick as MenuKey) ? menuPick! : menuOrder[0]!;
  /** `null` for a tab that draws its own screen; otherwise the stream, narrowed. */
  const streamKind = activityKindOf(shownKey);
  const onTheStream = streamKind !== null || shownKey === 'timeline';

  /*
    Which field holds the name. `module.labelFields` is what every other
    screen reads a record's heading from, so the heading and the field its
    edit writes to cannot disagree.
  */
  /** The email dialog, open against the record on screen. */
  const [composing, setComposing] = useState(false);
  /** The tag dialog, opened from *More actions* since the header's icon went (2 October 2026). */
  const [tagging, setTagging] = useState(false);

  const nameField = useMemo(
    () => module.fields.find((f) => f.name === module.labelFields?.[0]),
    [module.fields, module.labelFields],
  );
  const { data: assignableUsers = [] } = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.users(false, false, true),
    enabled: Boolean(assignedField),
    staleTime: 5 * 60_000,
  });
  /*
    Every agent's photo, by their id — *"Replace small Avtar from Agent Name in
    the left pane of records if profile Picture available, the the profile pic
    will be shown on Agent/User Avtar"* (3 October 2026).

    **By id, never by name.** The record stores the user's id and the queue row
    carries it, so the lookup is exact; matching on the displayed name would
    silently lose anybody whose name is spelt two ways. This is the directory
    the pane already fetches for the assignment control — no second request.
  */
  const agentPhotos = useMemo(
    () => new Map<string, string | null>(
      assignableUsers.map((candidate) => [
        String(candidate.id ?? ''),
        candidate.avatarUrl ? String(candidate.avatarUrl) : null,
      ]),
    ),
    [assignableUsers],
  );
  const assignedUserId = assignedField ? String(active?.values[assignedField.name] ?? '') : '';
  const assignedName = assignedField
    ? String(active?.display?.[assignedField.name]
      || assignableUsers.find((candidate) => candidate.id === assignedUserId)?.fullName
      || '')
    : '';
  const cardFields = useMemo(() => queueCardFields(module.fields), [module.fields]);
  const phoneValue = active && phoneField ? displayOf(active, phoneField) : '';
  const emailValue = active && emailField ? displayOf(active, emailField) : '';
  const { data: matchingCount } = useQuery({
    queryKey: ['workspace-matching-count', module.name, active?.id],
    // Any module has neighbours — this is what Save & dial next walks, and
    // naming two modules here left a third one unable to move through its own
    // queue. The record's id is the only real condition.
    enabled: Boolean(active?.id),
    staleTime: 60_000,
    queryFn: async (): Promise<number> => {
      if (!active) return 0;
      if (module.name === 'leads') return (await api.matchProperties(module.name, active.id, false, 50)).matches?.length ?? 0;
      return (await api.buyersForProperty(active.id, false, 50)).buyers?.length ?? 0;
    },
  });

  /*
    The numbers on the icon tabs. Each asks the same question, on the same
    key, as the tab it labels — so opening a tab shows what was already
    counted, with no second request, and the badge and the list cannot
    disagree. The timeline asks for its newest sixty; past that it says "60+".
  */
  const { data: feed } = useActivityEntries(module.name, active?.id ?? '', 'all');
  const { data: fileRows } = useQuery({
    queryKey: ['files', active?.id],
    queryFn: () => api.files(active!.id),
    enabled: Boolean(active?.id),
    staleTime: 60_000,
  });
  const { data: callRows } = useQuery({
    queryKey: ['record-calls', active?.id],
    queryFn: () => api.calls({ recordId: active!.id, limit: 50 }),
    enabled: Boolean(active?.id),
    staleTime: 60_000,
  });
  const menuCount = (key: MenuKey): string | null => {
    const shown = (count: number | undefined, cap: number): string | null => {
      if (!count) return null;
      return count >= cap ? `${cap}+` : String(count);
    };
    if (key === 'timeline') return shown(feed?.length, FEED_LIMIT);
    if (key === 'matching') return shown(matchingCount, 50);
    if (key === 'files') return shown(fileRows?.length, 1000);
    if (key === 'calls') return shown(callRows?.length, 50);
    // The three stream entries count out of the same answer the tabs do, so a
    // badge and the list it labels cannot disagree and nothing is asked twice.
    const kind = activityKindOf(key);
    if (kind) return shown(feed?.filter((entry) => entry.type === kind).length, FEED_LIMIT);
    return shown(feed?.filter((entry) => entry.type === 'message' && entry.meta.channel === 'whatsapp').length, FEED_LIMIT);
  };

  /*
    What the queue's one menu can do — eight questions and a direction, the
    same eight in both modules, none of them named in this file.

    It used to be built out of the module's own fields: the name A–Z, then one
    row per subtitle field, then the stage. The owner asked for those to go on
    27 September 2026 and for these in their place. On 1 October he took
    "No sorting" out: a list nobody sorted is Recently updated, newest first.
  */
  const choices = useMemo(() => sortOptions(followUpField?.name), [followUpField?.name]);
  const chosen = activeSortOption(choices, sortBy);
  const firstSortable = choices.find((option) => option.by);
  // A column heading clicked in the table view is not one of the eight, so the
  // button says which field it is rather than claiming one of them.
  const sortedByColumn = chosen ? null : module.fields.find((field) => field.name === sortBy);

  /*
    The three dots, brought across from the record page on the owner's ask.

    Not a link to that page — he asked for the split view to be somewhere you
    never leave — so the same four actions are done here, against whichever
    record the queue has open. The dialogs are the record page's own
    components rather than copies: one Share-with-team panel, one confirm.
  */
  const [summarising, setSummarising] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<'leads' | 'properties' | null>(null);

  const move = useMutation({
    mutationFn: (target: 'leads' | 'properties') => api.move(module.name, active!.id, target),
    onSuccess: (moved, target) => {
      toast.success(`Moved to ${target === 'properties' ? 'Inventories' : 'Leads'}`, moved.label);
      invalidateRecordQueries(queryClient, module.name, active?.id);
      void queryClient.invalidateQueries({ queryKey: ['records', target] });
      // The record has left this module, so the queue must forget it rather
      // than keep a pane open on something that is no longer here.
      void queryClient.invalidateQueries({ queryKey: ['records', module.name] });
      setActiveId(null);
    },
    onError: (err: Error) => toast.error('Could not move it', err.message),
  });

  // A list row carries no `can`, so the module's own permission stands in
  // until the record itself arrives and answers for this row.
  const canEdit = active?.can?.edit ?? module.permissions.edit;
  // Light the Call action while this record owns the permanent deck's live call.
  const onCall = useCallIsOn(module.name, active?.id ?? '');
  // A folded pane opens itself while the filters or a call on this record are
  // up — the call deck lives in it (the owner, 3 October 2026: pressing Call
  // should not need the pane opening by hand). It folds back when the call ends.
  const paneOpen = !paneFolded || Boolean(filterBar?.open) || onCall;
  const allChecked = rows.length > 0 && rows.every((row) => selected.has(row.id));

  /*
    One provider around the whole view, **not keyed on the open record**.
    Keyed, every click in the list rebuilt the entire split view — list
    included — so the list jumped back to the top and the record just clicked
    scrolled out of sight (26 September 2026, the owner). A call belongs to the
    record it was started from through `useLiveCall` now, and the WhatsApp
    composer closes itself when the record changes, so neither needs the key.
  */
  /*
    `nextId` stays undefined until this record's neighbours have arrived. A
    call placed before then — Save & Next rings the next record the moment it
    opens — would otherwise freeze "nobody is next" into the call and lose its
    own Save & Next button (the owner, 1 October 2026). Undefined lets the
    deck ask for itself.
  */
  return <CallDispositionProvider recordId={active?.id ?? ''} module={module.name} queue={{
    nextId: neighbours ? neighbours.nextId : undefined,
    position: neighbours?.position ?? null,
    total: neighbours?.total ?? null,
    url: callQueueUrl,
  }}>
    <WhatsAppComposerProvider recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
    <section data-testid="ipropy-workspace" className="bg-[var(--app-bg)] dark:bg-slate-950">
    {/*
      A fixed-height row with one draggable divider, not a min-height one.

      Height rather than min-height is what closes the white gap under the
      queue the owner reported: with `min-h` the two panes are as tall as the
      taller of them, the queue stops at its last row, and the page keeps
      scrolling past it. Fixed to the viewport, each pane scrolls inside
      itself, so the queue shows as many records as the screen can hold and
      ends exactly at the bottom of it.

      Below `xl` only one pane is on screen at a time (see `showing`), so this
      is a full-height row at every width — each pane scrolls inside itself on
      a phone exactly as it does on a laptop. The width is ignored below `xl`
      and the handle is `xl:block`, because a divider you cannot see is not one
      you can drag.
    */}
    <div
      ref={shell}
      className="flex h-[var(--pane-h)] min-h-0 flex-row bg-white dark:bg-slate-950"
      style={{
        ['--queue-w' as string]: `${queueWidth}px`,
        ['--pane-h' as string]: paneTop ? `calc(100vh - ${paneTop}px)` : 'calc(100vh - 13rem)',
      }}
    >
      {/* ---------------------------------------------------------------- */}
      {/* Pane 1 — the queue.                                              */}
      {/* ---------------------------------------------------------------- */}
      {/*
        Not `overflow-hidden`: the chips in this pane open panels wider than the
        pane (the Task queue is 27rem), and they are positioned against their
        buttons rather than drawn in a portal, so a clipping pane would cut
        them off. The list inside scrolls on its own. `z-10` keeps an open
        panel above the record beside it.
      */}
      <aside
        className={cn(
          'relative z-10 w-full shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 xl:flex xl:w-[var(--queue-w)]',
          // `hidden xl:flex`, never unmounted — the queue keeps its scroll
          // position and its loaded page while the record is on screen.
          showing === 'record' ? 'hidden' : 'flex',
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
          <span className="flex min-w-0 items-center gap-1.5">
            {/* Beside the module's own name, because that is what it selects:
                everything on this page, for the bulk-edit bar the list already
                carries. */}
            {onToggleAll && (
              <input
                type="checkbox"
                aria-label={`Select all ${module.label.toLowerCase()} shown`}
                checked={allChecked}
                onChange={(event) => onToggleAll(event.target.checked)}
                className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-slate-300"
              />
            )}
            <span className="flex min-w-0 items-center gap-1 truncate text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
              <ModuleIcon name={module.icon} className="h-3 w-3 shrink-0 text-slate-400" />
              <span className="truncate">{module.label}</span>
              <span className="shrink-0 font-normal text-muted">({rows.length})</span>
            </span>
          </span>
          {/*
            A Contact Type filter button stood here until 1 October 2026 —
            *"its no use to us at all"*, the owner. Filtering by any field,
            that one included, is the Quick & Live Filters panel's job.
          */}
          {onSort && (
            <Dropdown
              align="right"
              trigger={(
                <button
                  type="button"
                  className="flex max-w-[10rem] shrink-0 items-center gap-1 text-[11px] font-medium text-slate-600 transition-colors hover:text-brand-700 dark:text-slate-300 dark:hover:text-brand-300"
                  aria-label="Sort this list"
                >
                  <ArrowUpDown className="h-3 w-3 shrink-0 text-slate-400" />
                  <span className="truncate">
                    {chosen?.label ?? `Sorted by ${sortedByColumn?.label ?? 'a column'}`}
                  </span>
                </button>
              )}
            >
              {(close) => (
                <div className="py-1" data-testid="queue-sort-menu">
                  {/*
                    One direction control for the whole menu rather than a
                    second row per option — "Minimal Drop down, Specially
                    Sorting by Z-A / A-Z" (27 September 2026). With nothing
                    chosen it turns Recently updated round.
                  */}
                  <div className="flex items-center gap-1 px-3 pb-1.5 pt-1.5">
                    <p className="mr-auto text-2xs font-bold uppercase tracking-wide text-muted">Sort by</p>
                    {(['asc', 'desc'] as const).map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        disabled={!chosen?.by && !sortBy && !firstSortable?.by}
                        title={dir === 'asc' ? (chosen?.ascHint ?? 'A–Z') : (chosen?.descHint ?? 'Z–A')}
                        onClick={() => onSort(sortBy ?? chosen?.by ?? firstSortable?.by, dir)}
                        className={cn(
                          'rounded px-1.5 py-0.5 text-2xs font-bold transition-colors',
                          sortDir === dir && (chosen?.by || sortBy)
                            ? 'bg-brand-700 text-white'
                            : 'text-slate-500 hover:bg-[var(--surface-muted)] disabled:opacity-40 dark:text-slate-400',
                        )}
                      >
                        {dir === 'asc' ? 'A–Z' : 'Z–A'}
                      </button>
                    ))}
                  </div>
                  {choices.map((option) => (
                    <DropdownItem
                      key={option.key}
                      ariaLabel={option.key === 'task' ? 'Sort by task' : undefined}
                      icon={<Check className={cn('h-3.5 w-3.5', chosen?.key === option.key ? 'text-brand-600' : 'invisible')} />}
                      onClick={() => { onSort(option.by, sortDir ?? 'desc'); close(); }}
                    >
                      {option.label}
                    </DropdownItem>
                  ))}
                </div>
              )}
            </Dropdown>
          )}
        </div>
        {queueTools}
        {/* Flush, because each row draws its own hairline — one separator
            between records, which is what the owner asked for. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((row) => (
            <QueueCard
              key={row.id}
              row={row}
              active={row.id === active?.id}
              checked={selected.has(row.id)}
              card={cardFields}
              queueFields={queueFields}
              moduleName={module.name}
              nameField={nameField}
              assignedField={assignedField}
              agentPhotos={agentPhotos}
              canEdit={canEdit}
              onEdited={() => invalidateRecordQueries(queryClient, module.name, row.id)}
              onSelect={() => openRecord(row.id)}
              onToggle={(checked) => onToggleSelect(row.id, checked)}
            />
          ))}
        </div>
        {queueFooter}
      </aside>

      <SplitHandle label="Resize the list" width={queueWidth} onDrag={resize} />

      {/* ---------------------------------------------------------------- */}
      {/* Pane 2 — the record.                                             */}
      {/* ---------------------------------------------------------------- */}
      {/*
        The open record **and** what was said about it are one screen.

        On a laptop they are two columns, as they have always been. On a phone
        they are one column that scrolls together — the record, then the call
        deck and the notes under it — because a phone showing two panes
        side by side shows neither, and two scrollers on one screen is the
        complaint already written down about the WhatsApp tab.
      */}
      {active && <div
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col overflow-y-auto xl:flex xl:flex-row xl:overflow-hidden',
          // Hidden rather than unmounted while the queue has a phone's screen,
          // so coming back to a record does not refetch it.
          showing === 'list' ? 'hidden' : 'flex',
        )}
      >
      {/*
        `shrink-0` with its natural height on a phone, a filling column on a
        laptop. Inside a scrolling column `flex-1 min-h-0` lets a child
        collapse to nothing, which is exactly what happened: the record
        flattened to a few pixels and the notes pane below it was drawn over
        the top of it.
      */}
      <section className="flex w-full shrink-0 flex-col bg-white xl:min-h-0 xl:min-w-0 xl:flex-1 xl:shrink xl:overflow-hidden dark:bg-slate-900">
        {/*
          The way back, and only where there is a way back to.

          **2 October 2026, the owner:** *"as simple as GMAIL/WhatsApp App."*
          On a phone this screen replaced the list, so it needs the arrow every
          phone app has in that position. On a wide screen the list never went
          anywhere, so there is nothing to go back to and the row is not drawn
          (`xl:hidden`).
        */}
        <button
          type="button"
          onClick={() => setShowing('list')}
          data-testid="back-to-list"
          className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2 text-left text-sm font-semibold text-slate-600 hover:bg-slate-50 xl:hidden dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <ChevronLeft className="h-4 w-4 shrink-0" />
          {module.label}
        </button>

        {/*
          The hero, as the owner drew it on 27 September 2026: where this
          record sits in the queue and who owns it on one line, the face in the
          middle of its own completeness ring, the controls either side of it,
          and the facts a rep changes on a call along the bottom.
        */}
        {/*
          **30 September 2026, the owner's prototype:** *"The Header Have only
          avtar with Profile strength, Name, Updated Time … then All actionable
          icons with tree dot."* So the left is who this is — the face in its
          completeness ring, the name (still typed into where it stands) and
          how stale the record is — and the right is everything you can do to
          it. The agent, the stage, the chase date and the call log moved to
          the right-hand pane under the call deck, one line each; the number is
          on the queue card and in that pane too.
        */}
        {/*
          `flex-wrap` below `xl`: on a phone the controls take the next line so
          the **name** keeps the first one. Sharing one line with them, it
          truncated to "Header Keys ]" — three characters of the one thing on
          this screen that has to be readable, which is the same fault the
          chat header met once and is written down against it.
        */}
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-200/80 bg-white px-3 py-2 shadow-2xs xl:flex-nowrap dark:border-slate-800 dark:bg-slate-900" data-testid="split-hero-layout">
          <span className="shrink-0" data-testid="split-hero-avatar">
            <RecordAvatar
              module={module.name}
              recordId={active.id}
              name={active.label}
              canEdit={canEdit}
              size={56}
            />
          </span>
          <span className="flex min-w-[8rem] flex-1 flex-col justify-center gap-0.5 overflow-hidden">
            {/*
              **Which field carries the name is `module.labelFields`**, not the
              word "full_name": Inventories names a record by its unit and an
              admin may change either.
            */}
            <span className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 flex-1 basis-24 truncate text-sm font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
              {canEdit && nameField && isInlineEditable(nameField) ? (
                <EditableField
                  module={module.name}
                  recordId={active.id}
                  field={nameField}
                  value={active.values[nameField.name]}
                  display={active.label}
                  compact
                  siblings={active.values}
                  onSaved={() => invalidateRecordQueries(queryClient, module.name, active.id)}
                />
              ) : active.label}
            </h2>
            {/*
              The record's tags, on the name's own line — *"Please shift this
              tag beside/adjoining the Name"* (3 October 2026). They replaced
              "Updated …" here the day before; the queue still says how recently
              a record moved.

              **The name still gives way first.** `shrink-0` on the chips and
              `truncate` on the name means a long name shortens rather than
              pushing the tags off the row — and the name has a floor, because
              three characters of the one thing that has to be readable is the
              fault this header has already met once.
            */}
            </span>
            {/*
              How complete the record is, under the name — *"Remove and Change
              profile strength circle in to bar, that bar will shown below the
              Full name of Record"* (3 October 2026). It was four rings and a
              pill around the face; the face is just a face now, and the number
              reads as a proportion at a glance.
            */}
            {/*
              The bar under the name, three quarters of the width it was — *"the
              bar of profile strength long please make it 75% of current size"*
              (3 October 2026).

              **Call is not here any more.** It shared this line for an hour and
              he moved it again the same evening: *"Move the call icon after
              record number in Middle header pane"* — so it now sits beside the
              queue position on the right, which is where that number is.
            */}
            <StrengthBar
              percent={recordStrength(module.fields, active.values).percent}
              className="max-w-[10.5rem]"
            />
          </span>

          {/*
            **Its own row on a phone** (`basis-full` below `xl`). Call joined this
            group on 3 October 2026 and the group grew by a button, which was
            enough to start cutting the record's name on a 390px screen —
            measured at 36px lost. The name is the one thing on this header that
            has to be readable whole, so the group yields the line rather than
            squeezing it, which is what `flex-wrap` was already here for.
          */}
          <span className="ml-auto flex shrink-0 basis-full flex-wrap items-center justify-end gap-1.5 xl:basis-auto" data-testid="split-hero-actions-status">
            {/*
              **The module's name left this header on 3 October 2026** —
              *"Remove inventory/Lead labels/text from this middle header."*
              It arrived on 2 October and he has now worked the screen: the
              left toolbar already says which module is open, and the record in
              front of you is not somewhere you arrive by accident.
            */}
            {/* Where this record sits in the queue, and a step either way. */}
            {(active.tags?.length ?? 0) > 0 && (
              <TagChips module={module.name} tags={active.tags} className="flex shrink-0 items-center justify-center overflow-hidden" />
            )}
            <span className="mr-1 inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-slate-500" aria-label="Record navigation">
              <button type="button" aria-label="Previous record" title="Previous record" disabled={!neighbours?.prevId} onClick={() => neighbours?.prevId && openNeighbour(neighbours.prevId, Math.max(1, (neighbours.position ?? 2) - 1))} className="rounded p-0.5 transition hover:bg-slate-100 hover:text-brand-700 disabled:opacity-30 dark:hover:bg-slate-700">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-0.5 text-[11px] font-semibold tabular-nums text-slate-700 dark:text-slate-200" aria-live="polite">
                {neighbours?.position && neighbours.total ? `${neighbours.position} / ${neighbours.total.toLocaleString('en-IN')}` : '—'}
              </span>
              <button type="button" aria-label="Next record" title="Next record" disabled={!neighbours?.nextId} onClick={() => neighbours?.nextId && openNeighbour(neighbours.nextId, (neighbours.position ?? 0) + 1)} className="rounded p-0.5 transition hover:bg-slate-100 hover:text-brand-700 disabled:opacity-30 dark:hover:bg-slate-700">
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              {/* *"Move the call icon after record number in Middle header
                  pane"* (3 October 2026) — immediately after the `3 / 22,988`,
                  inside the same group, so the two cannot drift apart when the
                  header wraps on a phone. */}
              {phoneValue && <span className="ml-1 shrink-0"><CallButton to={phoneValue} iconOnly round active={onCall} /></span>}
            </span>
              {/*
                Search within this record. **The icon left this bar on
                3 October 2026** — *"remove the whatsapp icon and Search icon
                from the Middle header pane"* — and the search itself is a row
                in the menu bar's *More*. The box still opens here, where the
                icon used to be, because that is where a rep is already
                looking; it narrows the timeline and the fields pane to what
                mentions the words, and forgets them when another record opens.
              */}
              {finding ? (
                <span className="relative inline-flex items-center">
                  <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-slate-400" />
                  <input
                    autoFocus
                    value={findText}
                    onChange={(event) => setFindText(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape') { setFindText(''); setFinding(false); } }}
                    placeholder="Search this record…"
                    aria-label="Search this record"
                    className="h-8 w-44 rounded-full border border-slate-200 bg-white pl-7 pr-7 text-xs focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400 dark:border-slate-700 dark:bg-slate-800"
                  />
                  <button type="button" aria-label="Close record search" onClick={() => { setFindText(''); setFinding(false); }} className="absolute right-1.5 rounded p-0.5 text-slate-400 hover:text-slate-700">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : null}
              {/*
                **Nothing else is on this strip any more.** The three-dot menu
                went on 3 October — *"move/merge all in to More button in the
                Menu bar"* — and the email circle followed it the same evening:
                *"Move email icons from Middle heade pane to Menu bar more
                tab."* So what is left here is where the record sits in the
                queue, a step either way, and the search box when it is open.
              */}
          </span>
        </header>

        {/*
          The tag dialog lives out here, not in the menu panel above: a panel
          unmounts the moment it closes, and the dialog would go with it.
        */}
        <TagButton
          module={module.name}
          recordId={active.id}
          tags={active.tags}
          canEdit={canEdit}
          open={tagging}
          onOpenChange={setTagging}
        />

        {/*
          **30 September 2026, the owner's prototype:** the tabs are icons, each
          with its count — *"menu will be in icons instead of Text"*. The name
          is still there for a screen reader and on hover; the names are the
          Layout Designer's, and the first is the one a record opens on.

          **2 October 2026:** the order is now the rep's own, by dragging, with
          anything past the fifth under *More* — his *"user can set menu button
          and they can choose button as per their priority and if button too
          much, then 'More hamburger' will be shown"*.
        */}
        {/*
          Somebody has asked for this record — and the person who can say yes is
          the one looking at it (3 October 2026). Above the menu bar, because a
          question about *who owns this* comes before anything the bar offers.
        */}
        <AccessRequestBanner module={module.name} recordId={active.id} />

        <RecordMenuBar
          actions={(close) => (
            <>
              <DropdownItem icon={<Search className="h-3.5 w-3.5" />} onClick={() => { close(); setFinding(true); }}>
                Search this record
              </DropdownItem>
              {/*
                Write to them — *"Move email icons from Middle heade pane to
                Menu bar more tab"* (3 October 2026). It was a circle on the
                strip beside the record navigation; that strip now carries
                nothing but the navigation itself.

                **Only when there is an address to write to.** A row that can
                only say "no email on this record" is one a rep learns to
                ignore. Which field holds it is `useRecordPanes`, found by
                uitype, so no screen names a field.

                It opens the CRM's own composer rather than `mailto:` — the
                reply threads back onto the record, and a rep on a phone has no
                desktop mail client to hand it to.
              */}
              {emailValue && (
                <DropdownItem icon={<Mail className="h-3.5 w-3.5" />} onClick={() => { close(); setComposing(true); }}>
                  Email {emailValue}
                </DropdownItem>
              )}
              <DropdownItem
                icon={<Star className={cn('h-3.5 w-3.5', active.starred && 'fill-amber-500 text-amber-500')} />}
                onClick={() => { close(); star.mutate(active); }}
              >
                {active.starred ? 'Remove from starred' : 'Star this record'}
              </DropdownItem>
              {canEdit && (
                <DropdownItem
                  icon={<Tag className={cn('h-3.5 w-3.5', active.tags?.length && 'text-brand-600 dark:text-brand-300')} />}
                  onClick={() => { close(); setTagging(true); }}
                >
                  {active.tags?.length ? `Tags (${active.tags.length})` : 'Add a tag'}
                </DropdownItem>
              )}
              <DropdownItem
                icon={summarising ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                onClick={() => {
                  close();
                  setSummarising(true);
                  void api.summarise(module.name, active.id)
                    .then((result) => setSummary(result.summary))
                    .catch((err: Error) => toast.error('Summary failed', err.message))
                    .finally(() => setSummarising(false));
                }}
              >
                {summarising ? 'Summarising…' : 'Summarise with AI'}
              </DropdownItem>
              {canEdit && onDelete && (module.name === 'leads' || module.name === 'properties') && (
                <DropdownItem
                  icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
                  onClick={() => { close(); setMoveTarget(module.name === 'leads' ? 'properties' : 'leads'); }}
                >
                  Move to {module.name === 'leads' ? 'Inventories' : 'Leads'}
                </DropdownItem>
              )}
              {onDelete && (
                <DropdownItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={() => { close(); onDelete(active); }}>
                  Delete record
                </DropdownItem>
              )}
            </>
          )}
          order={menuOrder}
          shown={shownKey}
          onPick={setMenuPick}
          onReorder={reorderMenu}
          label={menuLabel}
          count={menuCount}
        />

        {/*
          What this entry lets a rep *start*, right under the bar — *"after
          selection of a Tab please give a option to make New call/Post
          Comment/Add New files/Send New whatsapp"*.

          Only where the screen below does not already offer it: Files opens on
          its own **Upload file** button and WhatsApp on its own message box,
          and a second button two centimetres above the first is how a rep
          learns to trust neither. There is no SMS row because this CRM cannot
          send one — an action that can only apologise is worse than none.
        */}
        <RecordMenuAction
          shown={shownKey}
          onStream={onTheStream}
          phone={phoneValue}
          recordId={active.id}
        />

        {/*
          **One scroll area, never two stacked.** The WhatsApp tab has its own
          scrolling message list; with this pane scrolling too, the wheel went
          to whichever happened to be under the mouse — 25 September 2026, the
          owner: *"only bringing mouse to a certain place scroll is working."*
          The timeline is the same: the stream scrolls, the notes box under it
          stays put.
        */}
        <div className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col',
          onTheStream || shownKey === 'whatsapp'
            ? 'overflow-hidden'
            // `xl:overflow-y-auto`, not `overflow-y-auto`: on a phone the whole
            // record column scrolls as one page, and a scroller inside a
            // scroller is how a finger ends up moving the wrong thing.
            : 'space-y-5 bg-[#fafbfa] p-5 xl:overflow-y-auto dark:bg-slate-950/40',
        )}>
          {onTheStream && (
            <>
              {/*
                One stream, four doors into it. `filter` is the bar's choice
                now, so the feed no longer carries a chip row of its own — that
                row named Calls and Files a second time, two rows apart,
                meaning something different each time.
              */}
              <ActivityFeed module={module.name} recordId={active.id} customerName={active.label} find={findText} filter={streamKind ?? 'all'} />
              <NoteComposer module={module.name} recordId={active.id} look="dock" whatsAppTo={phoneValue || undefined} />
            </>
          )}
          {shownKey === 'matching' && (module.name === 'leads' || module.name === 'properties') && <MatchingTab module={module.name} id={active.id} returnQuery="" recordLabel={active.label} />}
          {shownKey === 'files' && <FilesTab module={module.name} id={active.id} canEdit={canEdit} />}
          {shownKey === 'calls' && <CallsTab recordId={active.id} />}
          {shownKey === 'whatsapp' && <WhatsAppTab module={module.name} recordId={active.id} mobile={phoneValue || null} />}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Pane 3 — the call, and what was said.                            */}
      {/* ---------------------------------------------------------------- */}
      {(
        <aside
          data-testid="activity-pane"
          data-folded={paneOpen ? undefined : 'true'}
          className={cn(
            'relative flex w-full shrink-0 flex-col overflow-hidden border-l border-slate-200 bg-white transition-[width,max-height] duration-300 ease-in-out dark:border-slate-800 dark:bg-slate-900',
            paneOpen ? 'xl:w-[22.5rem]' : 'max-h-11 xl:max-h-none xl:w-11',
          )}
        >
          {filterBar?.panel}
          {/*
            Fold the whole pane away and back — the owner, 3 October 2026:
            *"fold/unfold on the click of a little button … nice transition"*.
            The content keeps its own width while the pane narrows round it, so
            nothing reflows mid-slide; it fades, and `inert` keeps a folded
            pane out of the Tab order. The Quick & Live Filters panel still
            opens here, so a folded pane opens itself while it shows — and while a
            call on this record is up, since the call deck lives here too.
          */}
          {paneOpen ? (
            <button
              type="button"
              onClick={() => setPaneFolded(true)}
              title="Fold the details away"
              aria-label="Fold the details pane"
              aria-expanded
              className="absolute left-0 top-1/2 z-20 hidden h-12 w-5 -translate-y-1/2 items-center justify-center rounded-r-lg bg-brand-600 text-white shadow-md transition hover:w-6 hover:bg-brand-700 xl:flex"
              data-testid="fold-details"
            >
              <ChevronRight className="h-4 w-4 shrink-0" strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPaneFolded(false)}
              title="Show the details"
              aria-label="Show the details pane"
              aria-expanded={false}
              className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-brand-50 text-brand-700 transition hover:bg-brand-100 xl:flex-col xl:justify-start xl:pt-3 dark:bg-slate-800 dark:text-brand-300 dark:hover:bg-slate-700"
              data-testid="unfold-details"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white shadow-sm"><ChevronLeft className="h-4 w-4 max-xl:-rotate-90" strokeWidth={2.5} /></span>
              <span className="text-[11px] font-bold uppercase tracking-widest xl:[writing-mode:vertical-rl] xl:rotate-180">Details</span>
            </button>
          )}
          <div
            inert={!paneOpen}
            className={cn(
              'flex min-h-0 w-full flex-1 flex-col transition-opacity duration-200 xl:w-[22.5rem] xl:flex-none xl:h-full',
              paneOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
          {/*
            The deck and the notes are one pane now — 27 September 2026, the
            owner: *"call deck merge in to Note/Comment pane/Box"*. The deck
            is always present above notes: at rest it says no call is running,
            and it expands into the working controls during a call. Saving a
            call returns it to that ready state instead of hiding the deck.
          */}
          <ProgressiveDialerPanel module={module.name} recordId={active.id} />
          <CallDeckPanel module={module.name} recordId={active.id} />
          {/*
            The record's own fields — *"the overview details form move to in
            replacement of Note/Comment pane below call deck"*. One line each,
            the three a call changes pinned first.
          */}
          <RecordInspector
            module={module}
            row={active}
            canEdit={canEdit}
            blocks={blocks}
            rows={rightPaneRows}
            assignedField={assignedField}
            assignedName={assignedName}
            statusField={statusField}
            followUpField={followUpField}
            find={findText}
          />
          </div>
        </aside>
      )}
      </div>}
    </div>

    {/*
      What the three-dots menu opens. Mounted once for the pane rather than
      per row, and keyed on nothing — each reads `active` at the moment it is
      opened, and each closes itself when it is done.
    */}
    <Modal
      open={Boolean(summary)}
      onClose={() => setSummary(null)}
      title={`Summary of ${active?.label ?? ''}`}
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-brand-100 bg-brand-50 p-4 text-sm leading-6 text-slate-700 dark:border-brand-900 dark:bg-brand-950 dark:text-slate-200">
          <SummaryText text={summary ?? ''} />
        </div>
        <p className="text-xs text-muted">
          Built only from the CRM fields and activity you are allowed to see; missing facts are not invented.
        </p>
      </div>
    </Modal>

    <ConfirmDialog
      open={moveTarget !== null}
      onClose={() => setMoveTarget(null)}
      onConfirm={async () => {
        if (moveTarget) await move.mutateAsync(moveTarget);
        setMoveTarget(null);
      }}
      title={`Move to ${moveTarget === 'properties' ? 'Inventories' : 'Leads'}?`}
      body="Matching values, files, and call history move to the new record. The original record is removed from its current module."
      confirmLabel={move.isPending ? 'Moving…' : 'Move record'}
    />

    {/* The CRM's own composer, the same one the record page opens, so a
        reply threads back onto the record either way. */}
    {composing && active && (
      <ComposeModal
        module={module.name}
        record={active}
        onClose={() => setComposing(false)}
        onSent={() => {
          setComposing(false);
          invalidateRecordQueries(queryClient, module.name, active.id);
        }}
      />
    )}
    </section>
    </WhatsAppComposerProvider>
  </CallDispositionProvider>;
}

/**
 * One record in the queue, as a card.
 *
 * **26 September 2026, the owner**, from a mock-up, in the colours he chose:
 *
 *   Name  [TYPE]                                         [ CONTACTED ]
 *   Single, 4 BHK Builder Floor, Greenfields Colony
 *   ₹1.85 Cr  2,100 sq.ft                                     [TODAY]
 *
 * The open record carries a violet bar down its left edge and a lifted ring,
 * so which one is open reads at a glance. The middle line is cut short with
 * "…" rather than wrapping, so every card is the same height.
 *
 * Which fields that line shows is the Field Manager's `config.listSubtitle`
 * flag and nothing else — Admin → Split View used to outrank it and was
 * removed on 27 September 2026.
 *
 * **27 September 2026, the owner:** *"Replace the Star icon with Lead/Inventory
 * Status."* So the corner that carried a favourite now carries the stage the
 * record is at, which is the fact a rep scans a queue for. Favouriting is
 * still on the record's own header, a click away.
 *
 * The card and its tick box are separate buttons laid over one another rather
 * than one button holding another. A button inside a button is not allowed in
 * HTML, and a screen reader cannot reach the inner one.
 */
function QueueCard({
  row, active, checked, card, queueFields,
  moduleName, nameField, assignedField, agentPhotos, canEdit, onEdited, onSelect, onToggle,
}: {
  row: RecordEnvelope;
  active: boolean;
  checked: boolean;
  card: CardFields;
  queueFields?: FieldMeta[];
  moduleName: string;
  nameField?: FieldMeta;
  /**
   * Who the record is assigned to.
   *
   * Passed in rather than found here: which field that is is `useRecordPanes`'
   * decision, the same one the record header reads, and a second answer to it
   * is how two screens come to name different agents for one record.
   */
  assignedField?: FieldMeta;
  /** Each agent's photo by user id, so the row can show a face. */
  agentPhotos?: Map<string, string | null>;
  canEdit: boolean;
  onEdited: () => void;
  onSelect: () => void;
  onToggle: (checked: boolean) => void;
}): JSX.Element {
  /*
    Which of the two facts on this row is being changed, if either.

    **28 September 2026, the owner:** *"Please Change Name and Contact Type in
    editable formate on double click, with cursor on Name or Cotact type
    accordingly in the Left pane record."*

    The editor **replaces the card** rather than sitting inside it. This card
    is a `<button>` with its tick box laid over the top precisely because a
    button inside a button is not allowed in HTML and a screen reader cannot
    reach the inner one — and an inline editor is several buttons. So for the
    moment somebody is typing, the row is a plain box with one editor in it.
  */
  const [editing, setEditing] = useState<'name' | null>(null);
  const editField = editing === 'name' ? nameField : undefined;
  const read = (field: FieldMeta): string => displayOf(row, field);
  /*
    **The second line, with nothing said twice** — the owner, 3 October 2026:
    *"the duplicate House No. are still tin left record pane there, Please Check
    and Remove one of them."*

    The unit number was printed on its own *and* again inside the description,
    because the Field Manager flags it as a subtitle field and this card also
    draws it as the unit. `oneOfEach` already dropped a repeat **within** the
    description; the unit sat outside it and so escaped. One list through one
    filter is the fix — and it keeps working when an admin flags or unflags a
    field, which naming the house-number field here would not.
  */
  const unit = card.unit ? read(card.unit) : '';
  const facts = queueFields ? queueFields.map((field) => read(field)) : [unitDescription(card, read)];
  const description = oneOfEach([unit, ...facts]);
  const agent = assignedField ? read(assignedField) : '';
  const agentId = assignedField ? String(row.values[assignedField.name] ?? '') : '';
  const price = card.price ? cardPrice(row.values[card.price.name]) : '';
  const areaUnitField = card.area?.config.unitField;
  const area = card.area
    ? cardArea(row.values[card.area.name], typeof areaUnitField === 'string' ? row.values[areaUnitField] : undefined)
    : '';
  /*
    The open record is brought into view when it was opened from somewhere
    else — global search, a link, Save & Next — and left exactly where it is
    when it was clicked, because `nearest` does nothing to a card already on
    screen.
  */
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (editing && editField) {
    return (
      <div ref={self} data-testid="queue-card" className="group relative border-b border-[var(--border)] px-3 py-4">
        <EditableField
          module={moduleName}
          recordId={row.id}
          field={editField}
          value={row.values[editField.name]}
          display={editing === 'name' ? row.label : read(editField)}
          compact
          openOnMount
          siblings={row.values}
          onClosed={() => setEditing(null)}
          onSaved={onEdited}
        />
      </div>
    );
  }

  /** A double-click opens that field, and only when this rep may edit. */
  const openEditor = (which: 'name') => (event: React.MouseEvent) => {
    if (!canEdit) return;
    event.stopPropagation();
    event.preventDefault();
    setEditing(which);
  };

  return (
    <div
      ref={self}
      data-testid="queue-card"
      className={cn(
        'group relative border-b border-[var(--border)]',
        /* A soft shadow under the open record, lifted above the card after it
           so the shadow is not painted over — *"a down shadow sort of not at
           all uncomfortable to eyes"* (2 October 2026). */
        active && 'z-[1] shadow-[0_6px_10px_-6px_rgba(15,23,42,0.28)]',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={cn(
          /* **More air between records** — *"Give more space in between rows of
             record in the left record pane"* (3 October 2026). The padding is
             the gap: each card draws the hairline under itself, so growing the
             rule's margin would move the line rather than the breathing room. */
          'relative block w-full cursor-pointer py-3 pl-[3.75rem] pr-3 text-left transition-colors',
          /*
            **27 September 2026, the owner:** *"Remove highlight box and shadow
            of box, We Need highlight whole box with only light colour for
            Selected record, When we Selected a record Then Font colour of Name
            and Price should be change as per theme."*

            So the open record is a light wash of the brand across the whole
            row and nothing else — no ring, no shadow, no bar down the edge,
            no border of its own. The rows are divided by one hairline each
            (the wrapper above), which is the separator he asked for; the card
            itself draws none.

            **Every colour here is a `brand-*` token**, which is the other half
            of that message: those resolve to CSS variables that Brand settings
            rewrites, so changing the theme moves this row with it. A hue
            written in as `indigo-50` would not have.
          */
          /*
            **28 September 2026, the owner:** *"Active Record Should be Darker
            As Theme Colour in Left Pane in All modules."* It was the palest
            step there is, which he asked for the day before and has now
            worked; the later decision stands. A step up is still a wash
            rather than a fill, so the name and the price on it keep their
            contrast without being reversed out to white.
          */
          /*
            **29 September 2026, the owner:** *"we need Normal View of record
            in left pane of split view but if we we Select or active a record
            Then Theme Dark Color … and text colour also change to white or
            lighter."*

            So an unopened row is an ordinary white card and the open one is a
            solid brand fill with white on it — the same rule as the toolbar
            above, and the same reason: "open" and "not open" read faster as
            two different *kinds* of thing than as two shades of one wash.

            Plain brand steps, never an opacity modifier — those compile to
            nothing on a bare `var()` and the row would keep its light fill on
            a dark page.
          */
          active
            ? 'bg-brand-50 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-brand-600 dark:bg-brand-700'
            : 'hover:bg-[var(--surface-muted)] dark:hover:bg-slate-800',
        )}
      >
        {/*
          The face on the row, and the same menu behind it as the record's own
          — *"Same as well as in Left record pane"* (3 October 2026). It shows
          the photo somebody uploaded rather than initials, which is the half
          that was missing here.

          **Outside the card's `<button>`**, a sibling rather than a child: a
          button inside a button is invalid HTML and a screen reader cannot
          reach the inner one, which is the same reason the tick box and the
          inline name editor sit out here too.
        */}
        <span className="pointer-events-none absolute left-3 top-1/2 z-[2] -translate-y-1/2" />
        {/*
          1. Who, and what kind of contact — the line a rep scans, so it is the
          heaviest thing on the card.
        */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            onDoubleClick={openEditor('name')}
            title={canEdit && nameField ? 'Double-click to rename' : undefined}
            className={cn(
              'truncate text-sm font-bold tracking-tight',
              active ? 'text-brand-900 dark:text-white' : 'text-slate-900 dark:text-slate-100',
            )}
          >
            {row.label}
          </span>
          {/* No contact-type chip beside the name since 2 October 2026 —
              *"I don't need to see it there"*. It is in the fields pane. */}
          {/* How stale it is, top right — the prototype's "6h ago". */}
          {row.updatedAt && (
            <span className={cn('ml-auto shrink-0 whitespace-nowrap text-[11px] font-medium', active ? 'text-brand-700 dark:text-brand-100' : 'text-muted')}>
              {relativeTime(row.updatedAt)}
            </span>
          )}
        </span>

        {/* No number here — *"I dont want to see phone number there"* (1 October
            2026). It is on the open record, beside its WhatsApp icon. */}

        {/* 2. Which unit, cut short with "…" rather than wrapped — and not
            drawn at all when there is nothing to say, rather than a dash. */}
        {description && <span className={cn(
          'mt-1 block min-w-0 truncate text-xs',
          // `brand-100` on the fill rather than a slate step: slate on brand
          // is the pair that lands around 2–3:1, which is the whole reason
          // `lib/color.ts` exists.
          active ? 'font-semibold text-brand-700 dark:text-brand-100' : 'text-slate-500 dark:text-slate-400',
        )}>
          {description}
        </span>}

        {/*
          3. The money and the size. No rule above it — *"Remove Separator Line
          In between second and Third Row"* — because the line between one
          record and the next is the only one this queue needs.
        */}
        {(price || area || agent) && <span className="mt-1 flex items-center gap-2 text-xs">
          {price && (
            <span className={cn(
              // The prototype's money green, a step dark enough for AA on both fills.
              'shrink-0 whitespace-nowrap text-[13px] font-bold tabular-nums text-emerald-700 dark:text-emerald-300',
            )}>
              {price}
            </span>
          )}
          {/* `text-muted` and not a slate step: the token is the one that
              carries a contrast guarantee in both themes. */}
          {area && (
            <span className={cn(
              'truncate text-[13px] font-medium',
              // `text-muted` is a guaranteed pair on the page's own surface
              // and not on a brand fill, so the open row states its own.
              active ? 'text-brand-700 dark:text-brand-100' : 'text-muted',
            )}>• {area}</span>
          )}
          {/*
            Who it belongs to, hard against the right edge — the owner,
            3 October 2026: *"We Need to display a Text of assign to agent name
            in third row After the Area/Size and agent name should be aligned
            from Right of the Record pane."*

            `ml-auto` pushes it right and `truncate` makes it the thing that
            gives way: the money and the size are what a rep is scanning this
            row for, and a long name must not squeeze them.
          */}
          {agent && (
            <span
              title={`Assigned to ${agent}`}
              className={cn(
                'ml-auto flex min-w-0 shrink items-center gap-1 pl-1 text-[11px] font-medium',
                active ? 'text-brand-700 dark:text-brand-100' : 'text-muted',
              )}
            >
              {/*
                Their photo, and their initials when they have not added one —
                *"if profile Picture available, the the profile pic will be
                shown on Agent/User Avtar"* (3 October 2026). `Avatar` already
                does both, and already knows that a CRM-hosted photo needs the
                session token in its address.
              */}
              <Avatar name={agent} src={agentPhotos?.get(agentId) ?? null} size={16} />
              <span className="min-w-0 truncate">{agent}</span>
            </span>
          )}
        </span>}
      </button>

      {/*
        The tick box, and nothing else, over the card's top-right corner.

        **The follow-up and stage chips were taken off on 27 September 2026**,
        on the owner's instruction — both facts are on the open record's own
        header, as chips, two inches away. A queue row that carries them as
        well is the same thing said twice in the one place a rep is scanning
        for a name.

        The box only shows on hover or once ticked, so the row reads as a name
        and a price until somebody reaches for a bulk action.
      */}
      <span className="absolute left-3 top-1/2 z-[2] -translate-y-1/2">
        <RecordAvatar module={moduleName} recordId={row.id} name={row.label} canEdit={canEdit} size={40} />
      </span>

      <span className="absolute bottom-2.5 right-2.5 flex items-center gap-1">
        <input
          aria-label={`Select ${row.label}`}
          type="checkbox"
          checked={checked}
          onChange={(event) => onToggle(event.target.checked)}
          className={cn(
            'h-3.5 w-3.5 rounded border-slate-300 transition-opacity',
            checked ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100',
          )}
        />
      </span>
    </div>
  );
}


/**
 * One block of the record's fields, editable where they stand.
 *
 * `surface` is deliberately the default — `record`, not `list`. The "editing
 * from a list" setting exists because turning a value into an edit box under
 * a cursor on a *list* is how a live mobile number gets changed by somebody
 * who only meant to read it. This pane is not that: you picked this record out
 * of the queue on purpose, and it is the record, shown beside the list rather
 * than on its own page. Gating it on that setting is what put an Edit button
 * here, which is the thing the owner asked to be rid of.
 */
function DeskTab({ active = false, onClick, label, count, children, drag }: {
  active?: boolean;
  onClick: () => void;
  label: string;
  count?: string | null;
  children: React.ReactNode;
  /** Where this entry sits, and how to move it. Absent: not arrangeable. */
  drag?: {
    index: number;
    dragging: boolean;
    onPickUp: (index: number) => void;
    onDrop: (to: number) => void;
    onNudge: (from: number, to: number) => void;
  };
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      draggable={Boolean(drag)}
      onDragStart={drag && (() => drag.onPickUp(drag.index))}
      onDragEnd={drag && (() => drag.onPickUp(-1))}
      onDragOver={drag && ((event) => { event.preventDefault(); })}
      onDrop={drag && ((event) => { event.preventDefault(); drag.onDrop(drag.index); })}
      /*
        **Alt + ← / → moves it too.** Dragging is a mouse, and an arrangement
        a keyboard cannot reach is an arrangement half the team does not have.
      */
      onKeyDown={drag && ((event) => {
        if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        event.preventDefault();
        drag.onNudge(drag.index, drag.index + (event.key === 'ArrowLeft' ? -1 : 1));
      })}
      aria-label={count ? `${label} (${count})` : label}
      aria-current={active ? 'page' : undefined}
      title={drag ? `${label} — drag to reorder, or Alt and an arrow key` : label}
      /*
        **The chosen one is a solid brand pill** — the owner, 3 October 2026:
        *"after selection the any menu from Menu bar the theme dark button also
        be there … so that we can easy highlighted Menu keys."* A 2px underline
        is easy to lose along a row of eight.

        One whole string per state, never a tint layered on top: `cn` is plain
        clsx with no tailwind-merge, so two `bg-*` utilities in one class list
        are decided by Tailwind's own stylesheet order rather than by the order
        they are typed. This repo has paid for that twice.
      */
      className={cn(
        'flex shrink-0 items-center gap-1.5 px-2 py-1 text-xs font-semibold transition-colors',
        drag && 'cursor-grab active:cursor-grabbing',
        drag?.dragging && 'opacity-40',
        active
          ? 'rounded-full bg-brand-700 text-white shadow-xs dark:bg-brand-600'
          : 'rounded-full text-slate-500 hover:bg-[var(--surface-muted)] hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200',
      )}
    >
      {children}
      {/* The name beside the icon — *"team is unable to understand just from
          icon"* (1 October 2026). */}
      <span className="whitespace-nowrap">{label}</span>
      {/* The count rides on whichever fill the button wears — a slate chip on
          a brand pill is the pair that lands around 2–3:1. */}
      {count && (
        <span className={cn(
          'rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums',
          active ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
        )}>{count}</span>
      )}
    </button>
  );
}
/**
 * The record's one menu bar: the first five as buttons, the rest under *More*.
 *
 * **2 October 2026, the owner:** *"Please Make Menu tab Drag and drop in menu
 * bar, so that user can set menu button and they can choose button as per their
 * priority and if button too much, then 'More hamburger' will be shown."*
 *
 * Native HTML5 drag-and-drop, no new dependency: a drop on a button moves the
 * dragged one into that place. The arithmetic of *which* place lives in
 * `moveEntry`, pure and tested, because a drop landing one position short is
 * the classic bug here and no amount of reading the code finds it.
 */
/**
 * How many menu entries the bar is wide enough to draw.
 *
 * **3 October 2026, the owner:** *"if Menu bar is full otherwise all menus
 * shown in toolbar till hidden/overlapping."* It used to be a flat five, which
 * on a wide screen left room for three more and on a narrow one scrolled
 * sideways.
 *
 * The same rule `HeaderFieldStrip` holds to, with one difference that matters:
 * the widths come from a **hidden row that never changes**, not from the
 * buttons on screen. Measuring the real ones oscillates — hiding a button
 * frees the width that said to hide it, which says to show it again, every
 * frame.
 */
function useHowManyFit(total: number): {
  fits: number;
  barRef: React.RefObject<HTMLElement | null>;
  ghostRef: React.RefObject<HTMLDivElement | null>;
} {
  const barRef = useRef<HTMLElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(ON_THE_BAR);

  useEffect(() => {
    const bar = barRef.current;
    const ghost = ghostRef.current;
    if (!bar || !ghost) return;
    const measure = (): void => {
      const children = Array.from(ghost.children) as HTMLElement[];
      const more = children.find((child) => child.hasAttribute('data-more'));
      const entries = children.filter((child) => child !== more);
      if (!entries.length) return;
      const GAP = 16; // gap-4, between every pair
      // 32px for the bar's own px-4, and room for More unless everything fits.
      const room = bar.clientWidth - 32;
      const moreWidth = (more?.offsetWidth ?? 0) + GAP;
      let used = 0;
      let count = 0;
      for (const entry of entries) {
        used += entry.offsetWidth + (count ? GAP : 0);
        // The last one needs no room for More, because there would be no More.
        const needsMore = count + 1 < entries.length;
        if (used + (needsMore ? moreWidth : 0) > room) break;
        count += 1;
      }
      setFits(Math.max(1, count));
    };
    measure();
    // The bar also narrows when the queue's divider is dragged, which moves no
    // window — so the element is watched, not the window.
    const watch = new ResizeObserver(measure);
    watch.observe(bar);
    watch.observe(ghost);
    return () => watch.disconnect();
  }, [total]);

  return { fits, barRef, ghostRef };
}

function RecordMenuBar({ order, shown, onPick, onReorder, label, count, actions }: {
  order: MenuKey[];
  shown: MenuKey;
  onPick: (key: MenuKey) => void;
  onReorder: (from: number, to: number) => void;
  label: (key: MenuKey) => string;
  count: (key: MenuKey) => string | null;
  /**
   * What this record itself can have done to it — star, tag, summarise, move,
   * delete, search.
   *
   * **3 October 2026, the owner:** *"You See Three dot of Dropdown fields
   * (Star, Tags, Summarise withAI, Move to, Delete recored) Please move/merge
   * all in to More button in the Menu bar."* So the header's own three-dot
   * circle is gone and there is **one** More on this screen rather than two a
   * few pixels apart, which is what he was looking at.
   */
  actions: (close: () => void) => ReactNode;
}): JSX.Element {
  const { fits, barRef, ghostRef } = useHowManyFit(order.length);
  const { bar, more } = splitMenu(order, fits);
  const [dragFrom, setDragFrom] = useState(-1);
  const pickUp = (index: number): void => setDragFrom(index);
  const drop = (to: number): void => {
    if (dragFrom >= 0) onReorder(dragFrom, to);
    setDragFrom(-1);
  };
  return (
    <div className="relative shrink-0">
      {/*
        The measuring row: every entry at full size, drawn where nobody can see
        it, so the widths it reports never change when the real bar below
        decides to hide one. Measuring the *real* buttons would oscillate — the
        count hides a button, which frees the width that said to hide it.

        **Outside the `<nav>`, deliberately.** Inside it, every locator looking
        for "the buttons on the menu bar" — a spec's, a screen reader's — found
        these first, and clicking one clicks something nobody can see.
      */}
      <div ref={ghostRef} aria-hidden className="pointer-events-none absolute left-4 top-0 flex items-center gap-4" style={{ visibility: 'hidden' }}>
        {order.map((key) => (
          <DeskTab key={key} onClick={() => undefined} label={label(key)} count={count(key)}>
            {MENU_ICON[key]}
          </DeskTab>
        ))}
        <span data-more className="flex items-center gap-1.5 px-1.5 py-2 text-xs font-semibold">
          <MoreHorizontal className="h-4 w-4" />
          <span>More</span>
        </span>
      </div>
    <nav
      className="flex items-center gap-4 border-b border-slate-200 bg-white px-4 text-slate-500 dark:border-slate-800 dark:bg-slate-900"
      aria-label="Record workspace sections"
      data-testid="record-menu-bar"
      ref={barRef}
    >
      {bar.map((key, index) => (
        <DeskTab
          key={key}
          active={shown === key}
          onClick={() => onPick(key)}
          label={label(key)}
          count={count(key)}
          drag={{ index, dragging: dragFrom === index, onPickUp: pickUp, onDrop: drop, onNudge: onReorder }}
        >
          {MENU_ICON[key]}
        </DeskTab>
      ))}
      {/*
        **Always here, even when nothing overflowed** — the record's own
        actions live in it since 3 October 2026, so it is never an empty
        control.
      */}
      <div className="ml-auto flex shrink-0 items-center">
        <Dropdown
          align="right"
          className="min-w-[15rem]"
          trigger={(
            <button
              type="button"
              className="flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-1.5 py-2 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              aria-label={more.length ? `More — ${more.length} more sections and record actions` : 'More record actions'}
              title="More"
              data-testid="record-menu-more"
            >
              <MoreHorizontal className="h-4 w-4" />
              <span className="whitespace-nowrap">More</span>
            </button>
          )}
        >
          {(close) => (
            <>
              {more.map((key, offset) => {
                const index = bar.length + offset;
                return (
                  <div key={key} className="flex items-center gap-1 px-1">
                    <button
                      type="button"
                      onClick={() => { onPick(key); close(); }}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold transition-colors',
                        shown === key ? 'text-brand-600 dark:text-brand-300' : 'text-slate-600 hover:bg-[var(--surface-muted)] dark:text-slate-300 dark:hover:bg-slate-800',
                      )}
                    >
                      {MENU_ICON[key]}
                      <span className="min-w-0 flex-1 truncate">{label(key)}</span>
                      {count(key) && <span className="shrink-0 text-[10px] tabular-nums text-muted">{count(key)}</span>}
                    </button>
                    {/*
                      Dragging *out of* a floating panel is not something a
                      browser does reliably — the panel closes on the first
                      pointer move. So an entry down here is promoted by a
                      button instead, which also works from a keyboard.
                    */}
                    <button
                      type="button"
                      onClick={() => onReorder(index, 0)}
                      aria-label={`Move ${label(key)} to the front of the bar`}
                      title="Move to the front of the bar"
                      className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-[var(--surface-muted)] hover:text-brand-600 dark:hover:bg-slate-800"
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              {/*
                The record's own actions, under a rule. One More on this
                screen, not two a few pixels apart (3 October 2026).
              */}
              {more.length > 0 && <div className="my-1 border-t border-[var(--border)]" />}
              {actions(close)}
            </>
          )}
        </Dropdown>
      </div>
    </nav>
    </div>
  );
}

/**
 * The one thing this section lets a rep start, drawn under the bar.
 *
 * **2 October 2026, the owner:** *"after selection of a Tab please give a
 * option to make New call/Post Comment/Add New files/Send New whatsapp/Send
 * New SMS under menu bar of selected tab in History Pane."*
 *
 * Only where the screen below does not already offer it. Files opens on its own
 * **Upload file** button and WhatsApp on its own message box; a second button
 * two centimetres above the first is how a rep learns to trust neither. **And
 * there is no SMS row, because this CRM cannot send one** — a control that can
 * only apologise is worse than no control, which is the rule the dead End
 * button on the call console already answers to.
 */
/**
 * Put the cursor in this record's note box, opening the dock first if it is
 * folded.
 *
 * Since 3 October 2026 the box at the foot of the record draws one line until
 * the mouse is over it, so on a click there is often **no box to focus yet** —
 * the button looked like it did nothing. Pressing the dock's own handle is what
 * opens it, and React renders on the next frame, which is what the retry waits
 * for. The handle is pressed once and once only: clicking it on every retry
 * would fold the dock again the moment it opened.
 */
function putTheCursorInTheNoteBox(recordId: string, framesLeft = 10, opened = false): void {
  const box = document.querySelector<HTMLTextAreaElement>(`[data-testid="note-box"][data-record="${recordId}"]`);
  if (box) {
    box.focus();
    box.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!opened) document.querySelector<HTMLButtonElement>('[data-testid="note-dock-handle"]')?.click();
  if (framesLeft > 0) requestAnimationFrame(() => putTheCursorInTheNoteBox(recordId, framesLeft - 1, true));
}

function RecordMenuAction({ shown, onStream, phone, recordId }: {
  shown: MenuKey;
  onStream: boolean;
  phone: string;
  recordId: string;
}): JSX.Element | null {
  if (shown === 'calls') {
    return phone ? (
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900" data-testid="record-menu-action">
        <CallButton to={phone} />
      </div>
    ) : null;
  }
  if (!onStream) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900" data-testid="record-menu-action">
      {/*
        The note box is already at the foot of the stream, so this puts the
        cursor in it rather than opening a second one somewhere else — two
        places to type a comment is two drafts to lose.
      */}
      <button
        type="button"
        className="btn-secondary btn-sm"
        onClick={() => putTheCursorInTheNoteBox(recordId)}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        Write a note
      </button>
      {phone && <WhatsAppButton to={phone} />}
    </div>
  );
}

function displayOf(row: RecordEnvelope, field: FieldMeta): string { const display = row.display?.[field.name]; if (display) return display; const value = row.values[field.name]; return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value); }

/** Whether a key press belongs to a text box, a dialog or a menu rather than to the queue. */
function isTypingOrInAPopup(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  return Boolean(target.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="log"]'))
    || Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
}
