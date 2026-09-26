import { type JSX, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime, type FieldMeta, type RecordEnvelope, type TimelineEntry } from '@ipropy/shared';
import { FileText, Send } from 'lucide-react';
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
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
    <header className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
      <p className="text-base font-bold text-slate-900 dark:text-white">{title}</p>
    </header>
    <dl className={cn('grid gap-x-8 gap-y-4 p-5', columns >= 3 ? 'sm:grid-cols-3' : columns === 1 ? '' : 'sm:grid-cols-2')}>{fields.map((field) => <div key={field.name}>
      <dt className="mb-1.5 text-2xs font-bold uppercase tracking-wide text-slate-500">{field.label}{field.isMandatory && <span className="ml-0.5 text-rose-500">*</span>}</dt>
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
          'min-h-10 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-100',
          canEdit && isInlineEditable(field) && 'cursor-pointer hover:border-brand-300',
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
            />
          : <FieldValue field={field} value={row.values[field.name]} display={row.display?.[field.name]} compact />}
      </dd>
    </div>)}</dl>
  </section>;
}

/**
 * The team's notes, beside the record's own fields rather than in a column of
 * their own. Two panes, as the owner asked on 19 September.
 */
export function NotesPanel({ module, record }: { module: string; record: RecordEnvelope }): JSX.Element {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const { data: entries, isLoading } = useQuery({ queryKey: ['timeline', module, record.id, 'comment'], queryFn: () => api.timeline(module, record.id, ['comment']) });
  const add = useMutation({
    mutationFn: () => api.addComment(module, record.id, note.trim()),
    onSuccess: () => { setNote(''); void queryClient.invalidateQueries({ queryKey: ['timeline', module, record.id] }); toast.success('Note added'); },
    onError: (error: Error) => toast.error('Could not add note', error.message),
  });
  return <section className="h-fit overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
    <header className="flex h-12 items-center gap-2 border-b border-slate-200 px-5 dark:border-slate-800"><FileText className="h-4 w-4 text-brand-600" /><h3 className="font-bold text-slate-900 dark:text-white">Notes</h3></header>
    <div className="p-4"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note for the team… type @ to notify someone" className="min-h-24 w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none placeholder:text-slate-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-800" /><div className="mt-2 flex items-center justify-between"><span className="text-2xs text-slate-400">⌘↵ to post</span><button disabled={!note.trim() || add.isPending} onClick={() => add.mutate()} className="btn-primary btn-sm"><Send className="h-3.5 w-3.5" />{add.isPending ? 'Posting…' : 'Post'}</button></div></div>
    <div className="max-h-[25rem] space-y-4 overflow-y-auto border-t border-slate-100 p-5 dark:border-slate-800">{isLoading ? <p className="text-sm text-slate-400">Loading notes…</p> : entries?.length ? entries.map((entry) => <NoteEntry key={entry.id} entry={entry} />) : <div className="py-10 text-center"><FileText className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">No notes yet</p><p className="mt-1 text-xs text-slate-400">Internal team comments appear here.</p></div>}</div>
  </section>;
}
function NoteEntry({ entry }: { entry: TimelineEntry }): JSX.Element { return <article><p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{entry.title}</p><p className="mt-0.5 text-2xs text-slate-400">{entry.actorName ?? 'iPROPY'} · {relativeTime(entry.at)}</p>{entry.body && <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-slate-600 dark:text-slate-300">{entry.body}</p>}</article>; }

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
export function HeaderFieldStrip({ module, row, fields, canEdit, className }: {
  module: DescribedModule; row: RecordEnvelope; fields: FieldMeta[]; canEdit: boolean; className?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const strip = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(fields.length);

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
  }, [fields, row.id]);

  return (
    <div className={cn('flex items-stretch gap-2 pb-0.5 text-sm font-medium text-slate-800 dark:text-slate-100', className)}>
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
        className="flex min-w-0 flex-1 items-stretch overflow-hidden whitespace-nowrap divide-x"
        style={{ borderColor: 'var(--border)' }}
      >
        {fields.map((field, index) => (
          <span
            key={field.name}
            className={cn(
              'inline-flex shrink-0 flex-col justify-center py-0.5',
              index === 0 ? 'pr-3.5' : 'px-3.5',
              index >= fits && 'invisible',
            )}
            style={{ borderColor: 'var(--border)' }}
          >
            <span className="key-label shrink-0">{field.label}</span>
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
      {fits < fields.length && (
        <span
          className="shrink-0 cursor-default select-none text-base leading-none tracking-widest text-slate-400"
          title="More fields than fit on one line. Choose fewer in Admin → Split View."
        >
          …
        </span>
      )}
    </div>
  );
}
