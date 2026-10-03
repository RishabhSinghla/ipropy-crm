/**
 * The face at the top of a record, inside its own completeness ring.
 *
 * **27 September 2026, the owner**, with a close-up of the ring he wants:
 * *"In the avtar we can add, Edit remove avtar Picture … Increase Avtar Size
 * with adjustment of Strength Circle Line to be Thin, a Full Circle line also
 * after aVatar and Percentage Text move to top of circle."*
 *
 * Four rings, outside in, because that is what his drawing shows: the pale
 * track, the green arc on top of it at the same radius, a thin full circle a
 * little inside, and a dashed hairline hugging the photo. The percentage sits
 * in a pill on the arc at the top right.
 *
 * **The photo is an ordinary attachment**, not a new column and not a new
 * table. It is the record's newest file under `category = 'avatar'`, so it
 * lives in the same place as every other file on the record, inherits the
 * image pipeline's thumbnails, obeys the same permissions, and appears on the
 * Files tab where somebody would look for it. Nothing new had to be built to
 * store it, which is why there is no migration here.
 */
import { type JSX, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Loader2, Trash2, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { Avatar, Dropdown, DropdownItem, Modal } from './ui';

/** What the record's own photo is filed under. */
const AVATAR_CATEGORY = 'avatar';

/** Big enough that a face is a face; a phone photo is scaled by the pipeline. */
const MAX_BYTES = 8 * 1024 * 1024;

interface RecordFile {
  id: string;
  category?: string | null;
  mime_type?: string | null;
  created_at?: string | null;
}

/**
 * Where a stored file is served from.
 *
 * `GET /api/records/:id/files` lists what a record has and deliberately does
 * **not** hand back a URL — every byte in this CRM comes through the one
 * permission-checked `/api/files/:id` route, which is also what puts the
 * token in the query string for an `<img>` that cannot send a header. Building
 * the address from the id here is the same thing the Files tab and the
 * WhatsApp renderer do.
 */
function fileUrl(id: string): string {
  return `/api/files/${id}`;
}

/**
 * The record's photo, if it has one.
 *
 * Shares `['files', recordId]` with the Files tab, so opening the record warms
 * that tab and uploading here refreshes it — one list of a record's files,
 * asked for once.
 */
function useRecordPhoto(recordId: string): { file: RecordFile | null; key: unknown[] } {
  const key = ['files', recordId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: async () => (await api.files(recordId)) as unknown as RecordFile[],
    enabled: Boolean(recordId),
    staleTime: 60_000,
  });
  const photos = (data ?? []).filter((file) => file.category === AVATAR_CATEGORY);
  // Newest wins: replacing a photo uploads a second one, and the old one stays
  // on the Files tab rather than being destroyed behind somebody's back.
  const newest = photos.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
  return { file: newest ?? null, key };
}

export function RecordAvatar({ module, recordId, name, canEdit, size = 96 }: {
  module: string;
  recordId: string;
  name: string;
  canEdit: boolean;
  size?: number;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { file, key } = useRecordPhoto(recordId);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: key });
  };

  const upload = useMutation({
    mutationFn: async (chosen: File) => {
      const uploaded = await api.uploadFile(chosen, recordId, module);
      // Two steps because `POST /api/files` files an attachment the ordinary
      // way and the category is what makes this one the record's face. A
      // failure here leaves a file on the Files tab rather than nothing at
      // all, which is the better of the two ways to fail.
      await api.updateFile(uploaded.id, { category: AVATAR_CATEGORY });
    },
    onSuccess: () => { refresh(); toast.success('Photo updated'); },
    onError: (err: Error) => toast.error('Could not upload the photo', err.message),
    onSettled: () => setBusy(false),
  });

  const remove = useMutation({
    mutationFn: async () => { if (file) await api.deleteFile(file.id); },
    onSuccess: () => { refresh(); toast.success('Photo removed'); },
    onError: (err: Error) => toast.error('Could not remove the photo', err.message),
    onSettled: () => setBusy(false),
  });

  const choose = (chosen: File | undefined): void => {
    if (!chosen) return;
    if (!chosen.type.startsWith('image/')) {
      toast.error('That is not a picture', 'Choose a JPEG, PNG or HEIC photo.');
      return;
    }
    if (chosen.size > MAX_BYTES) {
      toast.error('That picture is too big', `${(chosen.size / 1024 / 1024).toFixed(1)}MB — the limit is 8MB.`);
      return;
    }
    setBusy(true);
    upload.mutate(chosen);
  };

  const face = (
    <Avatar
      name={name}
      src={file ? fileUrl(file.id) : null}
      size={size}
      className="ring-2 ring-white dark:ring-slate-900"
    />
  );

  /*
    **The rings and the camera went on 3 October 2026**, on the owner's
    instruction: *"Please Remove and Change profile strength circle in to bar …
    and also Remove camera icon from Avtar but function will remain same even
    more function also appear after clicking of avatar i.e Preview, Upload,
    Remove, Replace."*

    So the face is the control. How complete the record is is a `StrengthBar`
    under the name now — see `IpropyWorkspace`.
  */
  if (!canEdit && !file) return <span className="inline-flex shrink-0">{face}</span>;

  return (
    <span className="relative inline-flex shrink-0">
      {canEdit && (
        <input
          ref={picker}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ''; }}
        />
      )}
      <Dropdown
        align="left"
        trigger={(
          <button
            type="button"
            disabled={busy}
            aria-label={`Photo of ${name}`}
            title={canEdit ? 'Preview, upload, replace or remove the photo' : 'Preview the photo'}
            className="relative inline-flex rounded-full transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60"
          >
            {face}
            {busy && (
              <span className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-white/70 dark:bg-slate-900/70">
                <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
              </span>
            )}
          </button>
        )}
      >
        {(close) => (
          <>
            {file && (
              <DropdownItem icon={<Eye className="h-3.5 w-3.5" />} onClick={() => { close(); setPreviewing(true); }}>
                Preview photo
              </DropdownItem>
            )}
            {canEdit && (
              <DropdownItem icon={<Upload className="h-3.5 w-3.5" />} onClick={() => { close(); picker.current?.click(); }}>
                {file ? 'Replace photo' : 'Upload photo'}
              </DropdownItem>
            )}
            {canEdit && file && (
              <DropdownItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                danger
                onClick={() => { close(); setBusy(true); remove.mutate(); }}
              >
                Remove photo
              </DropdownItem>
            )}
          </>
        )}
      </Dropdown>

      {/*
        The picture at a size somebody can actually look at. The same
        permission-checked `/api/files/:id` route the face reads, so nothing
        here is a second way to reach a record's bytes.
      */}
      <Modal open={previewing} onClose={() => setPreviewing(false)} title={name} size="lg">
        {file && <img src={fileUrl(file.id)} alt={name} className="mx-auto max-h-[70vh] w-auto rounded-xl" />}
      </Modal>
    </span>
  );
}

/**
 * How complete a record is, as a bar.
 *
 * **3 October 2026, the owner:** *"Please Remove and Change profile strength
 * circle in to bar, that bar will shown below the Full name of Record."* The
 * ring was four circles around the face and a pill on top of it, which is a lot
 * of drawing for one number; a bar says the same proportion at a glance and
 * leaves the face to be a face.
 *
 * `role="img"` with the percentage spoken, because a bar with no words is
 * nothing at all to a screen reader — the same label the ring carried, so
 * `e2e/listDefaultView.spec.ts` still finds it.
 */
export function StrengthBar({ percent, className }: { percent: number; className?: string }): JSX.Element {
  return (
    <span
      className={cn('flex items-center gap-1.5', className)}
      role="img"
      aria-label={`Record ${percent}% complete`}
      title={`This record is ${percent}% filled in`}
    >
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <span
          className="block h-full rounded-full bg-positive transition-[width] duration-500"
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </span>
      <span className="shrink-0 text-[10px] font-bold tabular-nums text-muted">{percent}%</span>
    </span>
  );
}
