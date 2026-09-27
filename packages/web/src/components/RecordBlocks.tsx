import { type JSX, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime, type FieldMeta, type RecordEnvelope, type TimelineEntry } from '@ipropy/shared';
import { FileText, LayoutList, Send } from 'lucide-react';
import { Avatar } from './ui';
import { FieldValue } from './FieldRenderer';
import { EditableField, isInlineEditable } from './EditableField';
import { invalidateRecordQueries } from '../lib/invalidate';
import type { DescribedModule } from '../lib/recordPanes';
import { api } from '../lib/api';
import { cn, restrictionForField } from '../lib/utils';
import { toast } from '../lib/store';

/**
 * A record's field card and its notes, shared by every screen that shows a
 * record beside something else.
 *
 * **Pulled out of `IpropyWorkspace` on 20 September 2026**, when the owner
 * asked for the whole record beside a WhatsApp chat rather than a summary he
 * had to click through: *"I had to switch screen … I want all info of that
 * record everything in the right pane"*. The split view and the Chats screen
 * render the same cards from the same code, so a record reads identically
 * whichever one you are looking at — a second copy would drift, and the way
 * it drifts is that one of them stops being inline-editable and nobody
 * notices for a month.
 */
export function FieldBlock({ module, title, columns, fields, row, canEdit }: {
  module: DescribedModule; title: string; columns: number; fields: FieldMeta[]; row: RecordEnvelope; canEdit: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  return <section className="card overflow-hidden">
    <header className="panel-head"><LayoutList className="h-4 w-4 text-brand-600" />{title}</header>
    <dl className={cn('grid gap-x-4 gap-y-4 p-5', columns >= 3 ? 'sm:grid-cols-3' : columns === 1 ? '' : 'sm:grid-cols-2')}>{fields.map((field) => <div key={field.name}>
      <dt className="key-label mb-1.5">{field.label}{field.isMandatory && <span className="ml-0.5 text-negative">*</span>}</dt>
      {/*
        The whole cell is the target, not just the value inside it.

        `EditableField` takes the click on its own box, which is only as wide
        as the value — so on an empty field that box is a dash in the middle of
        a wide cell and a click anywhere else in it hits nothing at all. That
        reads as inline editing being broken, which is the opposite of the ask.
        A click on the cell forwards to the field's own "Change …" control, so
        there is still exactly one thing that opens an editor.
      */}
      <dd
        className={cn(
          'key-tile text-sm font-medium text-slate-800 dark:bg-slate-800/70 dark:text-slate-100',
          canEdit && isInlineEditable(field) && 'cursor-pointer hover:ring-1 hover:ring-brand-300',
        )}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          event.currentTarget.querySelector<HTMLButtonElement>('button')?.click();
        }}
      >
        {canEdit && isInlineEditable(field)
          ? <EditableField
              module={module.name}
              recordId={row.id}
              field={field}
              value={row.values[field.name]}
              display={row.display?.[field.name]}
              siblings={row.values}
              restrictTo={restrictionForField(module.picklistDependencies, row.values, field.name)}
              onSaved={() => invalidateRecordQueries(queryClient, module.name, row.id)}
              plain
            />
          : <FieldValue field={field} value={row.values[field.name]} display={row.display?.[field.name]} compact plain />}
      </dd>
    </div>)}</dl>
  </section>;
}

/**
 * The team's notes, beside the record's own fields rather than in a column of
 * their own. Two panes, as the owner asked on 19 September.
 */
export function NotesPanel({ module, record, flush = false }: {
  module: string;
  record: RecordEnvelope;
  /**
   * Drop the card's own chrome and fill the parent instead.
   *
   * **27 September 2026, the owner:** the record's third pane *is* the notes
   * and comments, with the call deck merged into the top of it. A card inside
   * a pane is a border inside a border, and the list has to scroll with the
   * pane rather than inside a fixed 25rem window of its own. Same component
   * either way: a second copy of "post a comment" is how one of them learns
   * about a new query key and the other does not.
   */
  flush?: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const { data: entries, isLoading } = useQuery({ queryKey: ['timeline', module, record.id, 'comment'], queryFn: () => api.timeline(module, record.id, ['comment']) });
  const add = useMutation({
    mutationFn: () => api.addComment(module, record.id, note.trim()),
    onSuccess: () => { setNote(''); void queryClient.invalidateQueries({ queryKey: ['timeline', module, record.id] }); toast.success('Note added'); },
    onError: (error: Error) => toast.error('Could not add note', error.message),
  });
  const composer = (
    <div className={cn('rounded-xl border border-slate-200 bg-white p-2.5 shadow-2xs dark:border-slate-700 dark:bg-slate-800', !flush && 'border-0 p-4 shadow-none dark:bg-transparent')}>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        /* Deliberately not "call notes": while a call is up, the deck above
           this pane has a box of its own whose text is saved *with the call*.
           This one is the team's note on the record. Two boxes wearing one
           placeholder is how a rep types the wrong thing into the wrong one. */
        placeholder="Add a note for the team… type @ to notify someone"
        aria-label="Add a note for the team"
        className={cn('w-full resize-none text-xs text-slate-800 placeholder-slate-400 dark:text-slate-100', flush ? 'border-none bg-transparent p-0 focus:ring-0' : 'input min-h-24 p-3')}
        rows={flush ? 3 : undefined}
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-2xs text-muted">⌘↵ to post</span>
        <button disabled={!note.trim() || add.isPending} onClick={() => add.mutate()} className="btn-primary btn-sm">
          <Send className="h-3.5 w-3.5" />{add.isPending ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  );
  const stream = isLoading
    ? <p className="text-sm text-muted">Loading notes…</p>
    : entries?.length
      ? entries.map((entry) => <NoteEntry key={entry.id} entry={entry} flush={flush} />)
      : <div className="py-10 text-center"><FileText className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-3 text-sm font-semibold text-muted">No notes yet</p><p className="mt-1 text-xs text-muted">Internal team comments appear here.</p></div>;

  if (flush) {
    return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3.5" data-testid="notes-panel">
      {composer}
      {/* `text-muted` and not `text-slate-500`: that step is 4.1:1 on a dark
          panel, which the contrast scan catches on both modules. The token
          carries a guarantee in both themes, which is why it exists. */}
      <p className="mb-2 mt-4 text-[11px] font-bold uppercase tracking-wider text-muted">Activity &amp; comments</p>
      <div className="space-y-3">{stream}</div>
    </div>;
  }
  return <section className="card h-fit overflow-hidden" data-testid="notes-panel">
    <header className="panel-head"><FileText className="h-4 w-4 text-brand-600" /><h3 className="text-sm font-semibold">Notes</h3></header>
    {composer}
    <div className="max-h-[25rem] space-y-4 overflow-y-auto border-t border-slate-100 p-5 dark:border-slate-800">{stream}</div>
  </section>;
}
function NoteEntry({ entry, flush = false }: { entry: TimelineEntry; flush?: boolean }): JSX.Element {
  return <article className={cn(flush && 'rounded-xl border border-slate-200/70 bg-cream-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/60')}>
    <p className="flex items-center gap-1.5 text-xs">
      {entry.actorName && <Avatar name={entry.actorName} size={20} />}
      <span className="truncate font-bold text-slate-900 dark:text-slate-100">{entry.actorName ?? 'iPROPY'}</span>
      <span className="shrink-0 text-[10px] text-muted">· {relativeTime(entry.at)}</span>
    </p>
    <p className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{entry.title}</p>
    {entry.body && <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-700 dark:text-slate-300">{entry.body}</p>}
  </article>;
}

/**
 * The record's facts on one line, each typed in where it stands.
 *
 * The owner's instruction of 19 September — *"Mobile, Budget, Next Followup,
 * Status, Unit Number etc. are shown in two row Please set all in one row"* —
 * and of 20 September, that the WhatsApp chat header must carry the same
 * strip. One component, so the two headers cannot disagree about which fields
 * those are or how they wrap.
 *
 * **It counts what fits rather than only clipping.** Clipping alone cut the
 * last field through the middle of a word — "Budg…" — which reads as a broken
 * screen rather than as a full line. The ones that do not fit are made
 * *invisible rather than unmounted*: they keep their space, so the
 * measurement that produced the count stays true and the count cannot
 * oscillate between two answers on every frame.
 *
 * A window listener is not enough: the strip also narrows when a divider is
 * dragged, which moves no window. `ResizeObserver` watches the element.
 */
export function HeaderFieldStrip({ module, row, fields, canEdit, className, variant = 'columns' }: {
  module: DescribedModule; row: RecordEnvelope; fields: FieldMeta[]; canEdit: boolean; className?: string;
  /**
   * How each field is drawn.
   *
   * `columns` is the ledger strip — the label above the fact, divided by
   * hairlines — which is what the WhatsApp chat header shows. `chips` is the
   * owner's prototype of 27 September 2026, where the record hero's bottom row
   * is a line of small bordered chips carrying the *value* alone, with the
   * field's name on hover. Two looks, **one measuring rule**: a second copy of
   * the count-what-fits logic is how one header would learn about a new field
   * and the other would not.
   */
  variant?: 'columns' | 'chips';
}): JSX.Element {
  const queryClient = useQueryClient();
  const strip = useRef<HTMLDivElement>(null);
  /*
    A chip carries the fact and not its name, so an empty one is a small
    bordered dash saying nothing — and two of them are the row. The ledger
    strip keeps its blanks, because there the label above still tells a reader
    what is missing.
  */
  const shown = variant === 'chips'
    ? fields.filter((field) => {
      const value = row.display?.[field.name] ?? row.values[field.name];
      return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && String(value).trim() !== '';
    })
    : fields;
  const [fits, setFits] = useState(shown.length);

  useEffect(() => {
    const box = strip.current;
    if (!box) return;
    const measure = (): void => {
      const width = box.clientWidth;
      /*
        Measured from the strip's own left edge, not `offsetLeft`, which is
        relative to the nearest *positioned* ancestor. In the split view that
        ancestor happens to start where the strip does and the two agree; in
        the Chats header the strip sits 390px in, so every field computed as
        "does not fit" and the whole line went invisible — leaving a lone `…`
        and a header that looked broken.
      */
      const left = box.getBoundingClientRect().left;
      let count = 0;
      for (const child of Array.from(box.children) as HTMLElement[]) {
        if (child.getBoundingClientRect().right - left > width + 1) break;
        count += 1;
      }
      setFits(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [shown, row.id]);

  return (
    <div className={cn(
      /*
        A band, not a line of text.

        26 September 2026, the owner: *"Increase the stripe size end to end
        from left to right … and Little bit from bottom and Top … Light color
        Background of the Mobile, House No., Portion, Next Follow Up, Lost
        Reason, and also be little bit lighter colour of this background."*
        The caller decides how far it runs — the split view's header lets it
        out to the panel's own edges — and the tone is `--surface-subtle`,
        one step lighter than a field tile, because across a whole header the
        recessed tone reads as a second panel.
      */
      'flex items-stretch gap-2 text-sm font-medium text-slate-800 dark:text-slate-100',
      variant === 'columns'
        ? 'bg-[var(--surface-subtle)] px-4 py-2 sm:px-5'
        : 'rounded-lg bg-white/70 px-2.5 py-1.5 dark:bg-slate-900/60',
      className,
    )}>
      {/*
        A ledger strip, not a sentence.

        It used to read `Mobile: +91 … Email: … Budget: …` on one line, so the
        labels and the facts carried the same weight and the eye had to parse
        punctuation to find a number. The design stacks each pair into its own
        column — the label above in structural micro-type, the fact below in
        the display face — divided by hairlines, which is what makes five keys
        readable at a glance instead of five in a row.
      */}
      <div
        ref={strip}
        data-testid="header-fields"
        className={cn(
          'flex min-w-0 flex-1 items-stretch overflow-hidden whitespace-nowrap',
          variant === 'columns' ? 'divide-x' : 'gap-2',
        )}
        style={{ borderColor: 'var(--border)' }}
      >
        {shown.map((field, index) => (
          <span
            key={field.name}
            title={variant === 'chips' ? field.label : undefined}
            className={cn(
              'inline-flex shrink-0 justify-center',
              variant === 'columns'
                ? cn('flex-col py-0.5', index === 0 ? 'pr-3.5' : 'px-3.5')
                : 'items-center rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs shadow-2xs dark:border-slate-700 dark:bg-slate-800',
              index >= fits && 'invisible',
            )}
            style={{ borderColor: 'var(--border)' }}
          >
            {variant === 'columns' && <span className="key-label shrink-0">{field.label}</span>}
            {canEdit && isInlineEditable(field) ? (
              <EditableField
                module={module.name}
                recordId={row.id}
                field={field}
                value={row.values[field.name]}
                display={row.display?.[field.name]}
                compact
                siblings={row.values}
                restrictTo={restrictionForField(module.picklistDependencies, row.values, field.name)}
                onSaved={() => invalidateRecordQueries(queryClient, module.name, row.id)}
              />
            ) : (
              <FieldValue field={field} value={row.values[field.name]} display={row.display?.[field.name]} compact />
            )}
          </span>
        ))}
      </div>
      {fits < shown.length && (
        <span
          className="shrink-0 cursor-default select-none text-base leading-none tracking-widest text-slate-400"
          title="More fields than fit on one line. Arrange fewer in the Layout Designer's header."
        >
          …
        </span>
      )}
    </div>
  );
}
