import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import { api } from '../lib/api';
import { invalidateRecordQueries } from '../lib/invalidate';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { Badge, Modal } from './ui';

/**
 * Tagging a record, from wherever the record is open.
 *
 * One component for the record page and the split view. The record page had
 * this and the split view did not — *"give an operational tag icon, which is
 * missing from header"* — and the cheap answer would have been a second copy
 * of the dialog. Two copies of one dialog drift: one of them learns about a
 * new tag colour, or stops saving through `invalidateRecordQueries`, and the
 * same action behaves differently depending on which screen you were on.
 *
 * The options come from `['tags', module]`, the key the record page already
 * uses to colour its chips, so opening this costs no extra request.
 */
export function TagButton({ module, recordId, tags, canEdit, className, iconClassName }: {
  module: string;
  recordId: string;
  tags: string[] | undefined;
  /** Absent for a read-only profile: the control is not offered rather than refused. */
  canEdit: boolean;
  className?: string;
  iconClassName?: string;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);

  // Only the tags this module offers: "Site Visit Done" is not a thing a
  // builder floor can be, and "Corner Unit" is not a thing a person can be.
  /*
    Fetched afresh every time the dialog opens.

    It shares its key with the chips below, which are on screen from the moment
    a record is — so by the time somebody opens this, the list has usually been
    cached for a while, and a tag an admin created in the meantime would simply
    not be offered. There is nothing on screen to say why. A round trip when a
    person opens a dialog costs nothing anybody can feel.
  */
  const { data: options } = useQuery({
    queryKey: ['tags', module],
    queryFn: () => api.tags(module),
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: open,
  });

  const save = useMutation({
    mutationFn: () => api.setTags(module, recordId, draft),
    onSuccess: () => {
      toast.success('Tags updated');
      setOpen(false);
      invalidateRecordQueries(queryClient, module, recordId);
    },
    onError: (err: Error) => toast.error('Could not update tags', err.message),
  });

  if (!canEdit) return null;
  const count = tags?.length ?? 0;

  return (
    <>
      <button
        type="button"
        className={cn(className, count > 0 && 'text-brand-600 dark:text-brand-300')}
        title={count ? `Tags: ${tags!.join(', ')}` : 'Add a tag'}
        aria-label="Edit tags"
        onClick={() => { setDraft(tags ?? []); setOpen(true); }}
      >
        <Tag className={cn(iconClassName ?? 'h-4 w-4', count > 0 && 'fill-brand-100 dark:fill-brand-950')} />
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Tags"
        size="sm"
        footer={(
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save tags'}
            </button>
          </>
        )}
      >
        <p className="mb-3 text-sm text-muted">Choose one or more shared tags to help the team find and group this record.</p>
        <div className="flex flex-wrap gap-2">
          {(options ?? []).map((tag) => {
            const chosen = draft.includes(tag.name);
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => setDraft((current) => chosen
                  ? current.filter((name) => name !== tag.name)
                  : [...current, tag.name])}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  chosen
                    ? 'border-transparent text-white'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
                style={chosen ? { backgroundColor: tag.color } : undefined}
              >
                {tag.name}
              </button>
            );
          })}
          {!options?.length && (
            <p className="text-sm text-muted">No tags exist yet. An administrator can create them in Admin → Tags.</p>
          )}
        </div>
      </Modal>
    </>
  );
}

/**
 * A record's own tags, as chips, wherever that record is open.
 *
 * The owner asked for them on every view — *"so that we can see easly all tag
 * on record view in table, Kanban and split view"* — and beside the header's
 * icons rather than buried at the end of a line of text. Table and Kanban both
 * open the record page, so this and the split view's header are the two places
 * it has to be, and one component is what keeps them saying the same thing.
 *
 * Colour goes through `Badge`, never a raw hex fill: a tag's colour is chosen
 * by an admin, and painting an arbitrary hue behind white text lands wherever
 * that hue happens to land. `lib/color.ts` keeps the pair above AA in both
 * themes.
 */
export function TagChips({ module, tags, className }: {
  module: string;
  tags: string[] | undefined;
  className?: string;
}): JSX.Element | null {
  // The same key the dialog above uses, so showing the chips costs no extra
  // request on a page that has already opened the tag list once.
  const { data: options } = useQuery({
    queryKey: ['tags', module], queryFn: () => api.tags(module), staleTime: 60_000,
  });

  if (!tags?.length) return null;
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {tags.map((name) => (
        <Badge key={name} color={options?.find((option) => option.name === name)?.color ?? null} className="max-w-[10rem] truncate">
          {name}
        </Badge>
      ))}
    </span>
  );
}
