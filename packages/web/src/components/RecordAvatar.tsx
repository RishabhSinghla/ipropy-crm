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
import { Camera, Loader2, Trash2, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { Avatar, Dropdown, DropdownItem } from './ui';

/** What the record's own photo is filed under. */
const AVATAR_CATEGORY = 'avatar';

/**
 * The dashed circle's radius, as a share of the panel's width — and the
 * photo's own edge, because the owner asked for the two to meet.
 *
 * One number for both, so the day somebody moves the ring the face moves with
 * it rather than leaving the gap this was raised about.
 */
const DASHED_RING = 0.385;

/** The white hairline drawn around the photo (`ring-2`), in pixels. The photo
 *  shrinks by it on each side so that ring — not the picture — is what meets
 *  the dashed circle. */
const PHOTO_RING = 2;

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

export function RecordAvatar({ module, recordId, name, percent, canEdit, size = 96 }: {
  module: string;
  recordId: string;
  name: string;
  /** How complete the record is, 0–100. The arc and the pill read the same number. */
  percent: number;
  canEdit: boolean;
  size?: number;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { file, key } = useRecordPhoto(recordId);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <StrengthRings percent={percent} size={size} name={name} />

      {/*
        The photo, filling the dashed hairline.

        **28 September 2026, the owner:** *"There are three lines after
        avatar. Please increase the avtar size till touch inner circle first
        line, so that we see the picture as big as."* It was 62% of the
        panel's width against a dashed circle at 77%, so a fifth of the space
        inside the rings was empty and the face was the smallest thing in its
        own portrait.

        `DASHED_RING` is the shared number: the photo's diameter and the
        dashed circle's radius are printed from it, so the two cannot drift
        apart the next time either is touched.

        **It stops one white ring short of the dashes rather than on them.**
        He counted three lines and asked the photo to reach the first, so the
        first still has to be there when it arrives — grown flush, the
        photo's own ring covers the dashes and he is left with two. So the
        picture is the dashed circle less its ring on each side, and that
        ring is the hairline where the two meet.
      */}
      <Avatar
        name={name}
        src={file ? fileUrl(file.id) : null}
        size={Math.round(size * DASHED_RING * 2) - PHOTO_RING * 2}
        className="relative z-10 ring-2 ring-white dark:ring-slate-900"
      />

      {/*
        The number rides on the arc at the top right, where he drew it — and it
        is the same `percent` the arc is drawn from, so a pill and a ring that
        disagree is not expressible.
      */}
      <span
        className="absolute -top-1 right-0 z-20 translate-x-1/2 rounded-full bg-positive px-2 py-0.5 text-2xs font-bold leading-none text-white shadow-2xs"
        role="img"
        aria-label={`Form strength ${percent}%`}
      >
        {percent}%
      </span>

      {canEdit && (
        <>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ''; }}
          />
          {/*
            The camera sits on the photo's own bottom edge and is always there
            rather than on hover: a control that appears only under a mouse is
            a control a tablet cannot find.

            The absolute positioning is on this wrapper and not on the button:
            `Dropdown` puts its own relatively-positioned box between the two,
            so a button positioned against "its parent" lands against that box
            instead — which is how it ended up sitting on the face.
          */}
          <span className="absolute bottom-0 right-1 z-20">
          <Dropdown
            align="left"
            trigger={(
              <button
                type="button"
                disabled={busy}
                aria-label={file ? 'Change or remove the photo' : 'Add a photo'}
                title={file ? 'Change or remove the photo' : 'Add a photo'}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-xs transition-colors hover:bg-brand-600 hover:text-white disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
              </button>
            )}
          >
            {(close) => (
              <>
                <DropdownItem icon={<Upload className="h-3.5 w-3.5" />} onClick={() => { close(); picker.current?.click(); }}>
                  {file ? 'Replace photo' : 'Upload photo'}
                </DropdownItem>
                {file && (
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
          </span>
        </>
      )}
    </span>
  );
}

/**
 * The rings, drawn once.
 *
 * Thin on purpose — the owner asked for it twice — and the arc is `positive`
 * rather than a band of three colours: the number beside it already says how
 * full the record is, and a ring that changes colour as well says it twice in
 * a place where the eye is looking for a face.
 */
function StrengthRings({ percent, size, name }: { percent: number; size: number; name: string }): JSX.Element {
  /*
    Thin, twice asked for: the arc is 4% of the face's width, where the ring it
    replaced was nearly twice that. The two hairlines inside it are a single
    pixel each — they are structure, not measurement, and at any more weight
    they compete with the arc that is actually saying something.
  */
  const stroke = Math.max(3, Math.round(size * 0.04));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const hairline = size * 0.425;
  const dashed = size * DASHED_RING;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="absolute inset-0 -rotate-90"
      role="img"
      aria-label={`${name}: record ${percent}% complete`}
    >
      {/* The pale track the arc runs on. */}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-slate-200 dark:stroke-slate-700" />
      {/* How much is filled in. `round` caps, as drawn. */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        className="stroke-positive"
        strokeDasharray={`${(circumference * Math.max(0, Math.min(100, percent))) / 100} ${circumference}`}
      />
      {/* A full circle line after the arc, then the dashed hairline. */}
      <circle cx={size / 2} cy={size / 2} r={hairline} fill="none" strokeWidth={1} className="stroke-slate-200 dark:stroke-slate-700" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={dashed}
        fill="none"
        strokeWidth={1}
        strokeDasharray="2 3"
        className="stroke-slate-300 dark:stroke-slate-600"
      />
    </svg>
  );
}
