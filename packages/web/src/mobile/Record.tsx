/**
 * One record, shaped like the contact screen on the phone rather than a form.
 *
 * The order matters and is the whole design: who this is, what you would do
 * about them, then the details, then what has happened. The web version leads
 * with a two-column grid of thirty fields, which is the right answer at a desk
 * and the wrong one when somebody has picked up.
 *
 * Editing happens in place. Tap a value, a sheet comes up with that one field,
 * save. No edit mode, no separate page, no form to scroll to the bottom of —
 * and one field per save, so a dropped connection loses one change rather than
 * twenty minutes.
 *
 * Every field, section and order here comes from the module's metadata and its
 * detail layout, so an admin adding a field sees it on the phone with no
 * release. Nothing about leads or properties is written into this file.
 */
import { type JSX, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  type FieldMeta, type LayoutConfig, formatIndianPrice, relativeTime, toInternational,
} from '@ipropy/shared';
import {
  CalendarClock, FileText, ImagePlus, MessageCircle, MoreVertical, Phone, Send, Share2,
  StickyNote, Trash2,
} from 'lucide-react';
import { api, ApiError, authedFileUrl } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { dial, downloadFromUrl, openExternal, tap } from '../lib/nativeActions';
import { apiBase, isNative } from '../lib/native';
import { canShareRecords } from '../lib/sharing';
import { invalidateRecordQueries } from '../lib/invalidate';
import { FieldInput, FieldValue } from '../components/FieldRenderer';
import { ConfirmDialog, Spinner } from '../components/ui';
import { AppBar, Avatar, BarButton, Group, Row, Sheet } from './primitives';
import { useRecordPanes } from '../lib/recordPanes';
import { useNoteSnippets, appendSnippet } from '../lib/noteSnippets';

/**
 * A module shaped like one, for the moments before the real one has loaded.
 *
 * `useRecordPanes` is a hook, so it cannot wait behind the loading guard — and
 * it reads fields and layouts off whatever it is handed. A module with neither
 * answers "no header fields, no stage, no chase date", which is exactly right
 * while the describe is still in flight. Defined outside the component so it
 * is the same object on every render and nothing downstream re-computes.
 */
const EMPTY_MODULE = {
  name: '', label: '', fields: [], layouts: [],
  permissions: { view: false, create: false, edit: false, delete: false },
  picklistDependencies: [],
} as unknown as Parameters<typeof useRecordPanes>[0];

export default function MobileRecord(): JSX.Element {
  const { module = '', id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<FieldMeta | null>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<'notes' | 'matching' | 'files' | 'details'>('notes');

  const { data: meta } = useQuery({
    queryKey: ['module', module],
    queryFn: () => api.module(module),
    staleTime: 5 * 60_000,
  });

  const { data: record, isPending } = useQuery({
    queryKey: ['record', module, id],
    queryFn: () => api.record(module, id),
  });

  const { data: timeline } = useQuery({
    queryKey: ['timeline', module, id],
    queryFn: () => api.timeline(module, id),
    // The feed is the least urgent thing on the screen and the most expensive
    // to build, so it is never what the record waits for.
    enabled: Boolean(record),
  });

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.update(module, id, values),
    onSuccess: async () => {
      setEditing(null);
      await invalidateRecordQueries(queryClient, module, id);
      void tap();
    },
    onError: (err: Error) => toast.error(
      'Not saved',
      err instanceof ApiError ? err.message : 'Check your connection and try again.',
    ),
  });

  const addNote = useMutation({
    mutationFn: (body: string) => api.addComment(module, id, body),
    onSuccess: async () => {
      setNoteOpen(false);
      await invalidateRecordQueries(queryClient, module, id);
      toast.success('Note added');
    },
    onError: (err: Error) => toast.error('Note not added', err.message),
  });

  /*
    Sending a unit to a buyer, in one tap.

    The web asks for a label and an expiry first, which is right at a desk where
    somebody is sending five links and wants to tell them apart later. Standing
    in front of a buyer it is four decisions between wanting to send something
    and having sent it. So this mints a link and goes straight to the phone's
    share sheet — WhatsApp, SMS, email, whatever they use. The link is listed on
    the record afterwards and can be revoked from the web like any other.
  */
  const share = useMutation({
    mutationFn: async () => {
      const link = await api.createShareLink(module, id, {});
      const url = `${apiBase() || window.location.origin}/s/${link.token}`;
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: record?.label ?? 'Property',
        text: `Property details from iPropy\n${url}`,
        dialogTitle: 'Send to',
      });
      return url;
    },
    onError: (err: Error) => {
      // Cancelling the share sheet rejects. That is a decision, not a fault,
      // and shouting about it is how an app feels broken.
      if (/cancel/i.test(err.message)) return;
      toast.error('Could not send it', err.message);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.remove(module, id),
    onSuccess: async () => {
      await invalidateRecordQueries(queryClient, module, id);
      toast.success('Deleted');
      navigate(`/${module}`, { replace: true });
    },
    onError: (err: Error) => toast.error('Not deleted', err.message),
  });

  const fields = useMemo(() => {
    const map = new Map<string, FieldMeta>();
    for (const f of meta?.fields ?? []) map.set(f.name, f);
    return map;
  }, [meta]);

  /*
    Sections come from the detail layout an admin arranged. Falling back to
    every visible field in order rather than to nothing: a module with no
    layout row must still be readable, and "no layout" is a normal state for
    one somebody created this morning.
  */
  const blocks = useMemo(() => {
    const layout = meta?.layouts?.find((l) => l.type === 'detail' && l.is_default)
      ?? meta?.layouts?.find((l) => l.type === 'detail');
    const config = layout?.config as LayoutConfig | undefined;
    if (config?.blocks?.length) {
      return config.blocks.map((b) => ({
        key: b.key,
        label: b.label,
        fields: b.fields.map((n) => fields.get(n)).filter((f): f is FieldMeta => Boolean(f)),
      })).filter((b) => b.fields.length);
    }
    return [{ key: 'all', label: 'Details', fields: [...fields.values()] }];
  }, [meta, fields]);

  /*
    **Every hook here sits above the early return below**, which is not style:
    React forbids a hook that runs on some renders and not others, and the
    loading guard is exactly such a fork. The record may still be loading, so
    each of these is written to answer sensibly with nothing.
  */
  const panes = useRecordPanes(meta ?? EMPTY_MODULE);
  const stage = meta ? panes.statusField : undefined;
  const chase = meta ? panes.followUpField : undefined;

  /* How often this person has been rung, and when last — the prototype's
     "3 calls • Spoke 5h ago". Off the same endpoint the Calls page reads. */
  const { data: calls = [] } = useQuery({
    queryKey: ['record-calls', module, id],
    queryFn: () => api.calls({ recordId: id, limit: 50 }),
    enabled: Boolean(id),
    staleTime: 60_000,
  });

  /*
    What would suit them. Live rather than pinned: a snapshot is what somebody
    chose to keep, and on this screen a rep wants what matches *now*. Asked
    only once the tab is open, so the matching is not run for every record
    somebody merely glances at.
  */
  const { data: matching } = useQuery({
    queryKey: ['record-matches', module, id],
    queryFn: () => api.matchProperties(module, id, false, 6),
    enabled: Boolean(id) && tab === 'matching',
    staleTime: 2 * 60_000,
  });

  const [phone, phoneDisplay] = useMemo<[string | null, string | null]>(() => {
    if (!record) return [null, null];
    for (const [name, field] of fields) {
      if (field.uitype !== 'phone' || !record.values[name]) continue;
      /*
        A number is two fields here — a country picklist and the national
        digits (migration 026). `toInternational` is the one place that knows
        how to put them back together for dialling; writing it out by hand is
        how the lead-capture path silently threw away every automated lead.
      */
      const country = String(record.values[String(field.config?.countryField ?? 'country_code')] ?? 'India');
      return [toInternational(country, String(record.values[name])), record.display?.[name] ?? null];
    }
    return [null, null];
  }, [record, fields]);

  if (isPending || !record) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--app-bg)]">
        <Spinner className="h-6 w-6 text-brand-600" />
      </div>
    );
  }

  const canEdit = record.can?.edit !== false;

  /*
    The three facts the prototype puts in a row under the name — budget,
    possession and sentiment on his mock-up.

    **Which three is the admin's decision, never this file's.** They are the
    header fields `useRecordPanes` already resolves, the same answer the record
    page, the split view and the call console read, so renaming a field or
    re-arranging the header moves this too. The stage is dropped because it is
    already the chip beside the name, and an empty one is skipped: a tile
    reading "Possession —" is a third of this row saying nothing.
  */
  const alreadyOnScreen = new Set([
    stage?.name,
    // The number is the line under the name, and the name is the heading.
    // Repeating either in a tile an inch below is the duplication the chat
    // header met once — "Full Name" and "Mobile" between them ate that whole
    // strip — and it is dropped the same way, through metadata rather than by
    // naming a field.
    panes.phoneField?.name,
    ...(meta?.labelFields ?? []),
  ].filter(Boolean) as string[]);

  const tiles = (meta ? panes.headerFields : [])
    .filter((field) => !alreadyOnScreen.has(field.name))
    .map((field) => ({ field, text: String(record.display?.[field.name] ?? record.values[field.name] ?? '') }))
    .filter((tile) => tile.text && tile.text !== '—')
    .slice(0, 3);

  const notes = (timeline ?? []).filter((entry) => entry.type === 'comment');

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]">
      <AppBar
        title="Lead details"
        onBack={() => navigate(-1)}
        actions={(
          <BarButton icon={<MoreVertical className="h-5 w-5" />} label="More" onClick={() => setMenuOpen(true)} />
        )}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {/* ------------------------------------------------------------- */}
        {/* Who this is, and where the deal stands.                       */}
        {/* ------------------------------------------------------------- */}
        <div className="mt-3 rounded-2xl border border-[var(--border)] bg-white p-4 shadow-2xs dark:bg-slate-900">
          <div className="flex items-start gap-3">
            <Avatar name={record.label} size={56} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[17px] font-bold leading-tight text-slate-900 dark:text-white">
                {record.label}
              </h1>
              {phone && <p className="mt-0.5 truncate text-[13px] tabular-nums text-slate-500">{phoneDisplay ?? phone}</p>}
              <p className="mt-0.5 truncate text-[12px] text-slate-500">
                {/* How often, and how long ago — the one line that says whether
                    this person has been left alone. */}
                {calls.length > 0
                  ? `${calls.length} call${calls.length === 1 ? '' : 's'} · spoke ${relativeTime(String(calls[0]?.started_at ?? ''))}`
                  : 'No calls yet'}
              </p>
            </div>
            {/* The stage, in the colour the admin chose for it — through
                `Badge`, so the pair clears AA whichever hue that is. */}
            {stage && record.display?.[stage.name] && (
              <span className="shrink-0">
                <FieldValue field={stage} value={record.values[stage.name]} display={record.display?.[stage.name]} />
              </span>
            )}
          </div>

          {tiles.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {tiles.map(({ field, text }) => (
                <button
                  key={field.name}
                  type="button"
                  onClick={canEdit && !field.isReadonly
                    ? () => { setDraft(record.values[field.name] ?? null); setEditing(field); }
                    : undefined}
                  className="rounded-xl bg-[var(--surface-muted)] p-2.5 text-left dark:bg-slate-800"
                >
                  <span className="block truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    {field.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] font-bold text-slate-900 dark:text-white">
                    {text}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------- */}
        {/* What you would do about them.                                  */}
        {/* ------------------------------------------------------------- */}
        <div className="mt-3 flex justify-between gap-2">
          {phone && <Action icon={<Phone className="h-5 w-5" />} label="Call" onClick={() => dial(phone)} />}
          {phone && (
            <Action
              icon={<MessageCircle className="h-5 w-5" />}
              label="WhatsApp"
              onClick={() => void openExternal(`https://wa.me/${phone.replace(/[^\d+]/g, '')}`)}
            />
          )}
          {/*
            **"Add task" is the chase date**, not a task record: this CRM has
            no such thing, and `core/workflow/followUp.ts` is the one
            definition of "chase them on <date>". Offered only on a module that
            has somewhere to write it.

            **There is no SMS button**, which the prototype draws. The CRM has
            no SMS provider, and a button that can only apologise is worse than
            one that is not there — this repo has written that down twice.
          */}
          {chase && canEdit && (
            <Action
              icon={<CalendarClock className="h-5 w-5" />}
              label="Task"
              onClick={() => { setDraft(record.values[chase.name] ?? null); setEditing(chase); }}
            />
          )}
          <Action icon={<StickyNote className="h-5 w-5" />} label="Note" onClick={() => setNoteOpen(true)} />
          {canShareRecords(module, meta?.settings) && (
            <Action
              icon={share.isPending ? <Spinner className="h-5 w-5" /> : <Share2 className="h-5 w-5" />}
              label="Send"
              onClick={() => { if (!share.isPending) share.mutate(); }}
            />
          )}
        </div>

        {/* ------------------------------------------------------------- */}
        {/* Notes · Matching · Files · Details                             */}
        {/* ------------------------------------------------------------- */}
        {/*
          **Four tabs, where the prototype draws three.** Notes, Matching and
          Files are his; Details is the thirty-odd fields an admin arranged,
          which the mock-up has nowhere for and which a rep must still be able
          to read and edit. Dropping them to match the drawing exactly would
          make this screen the one place in the CRM where a field an admin
          added cannot be seen.
        */}
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {([
            ['notes', `Notes (${notes.length})`],
            ['matching', 'Matching'],
            ['files', 'Files'],
            ['details', 'Details'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                'shrink-0 rounded-full border px-4 py-2 text-xs font-semibold transition-colors',
                tab === key
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-[var(--border)] bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'notes' && (
          <div className="mt-3 space-y-2">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Team interaction log
            </p>
            {notes.length === 0 && <p className="px-1 py-6 text-center text-sm text-muted">Nothing written down yet.</p>}
            {notes.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="rounded-2xl border border-[var(--border)] bg-white p-3 shadow-2xs dark:bg-slate-900">
                <div className="flex items-center gap-2">
                  {/*
                    **`actorName`, not `title`** — a comment's title is the word
                    "Comment", so every note on this screen was signed by
                    nobody. The prototype's whole point here is that a rep can
                    see *who* on the team last spoke to this person.
                  */}
                  <Avatar name={entry.actorName ?? 'Someone'} size={28} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">
                    {entry.actorName ?? 'Someone'}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(entry.at)}</span>
                </div>
                <p className="mt-2 rounded-xl bg-[var(--surface-muted)] p-2.5 text-[13px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {entry.body}
                </p>
              </div>
            ))}
          </div>
        )}

        {tab === 'matching' && (
          <div className="mt-3 space-y-2">
            {!matching && <p className="px-1 py-6 text-center text-sm text-muted">Looking for what would suit them…</p>}
            {matching?.matches.length === 0 && (
              <p className="px-1 py-6 text-center text-sm text-muted">Nothing on the books matches yet.</p>
            )}
            {(matching?.matches ?? []).map((match) => (
              <button
                key={match.propertyId}
                type="button"
                onClick={() => navigate(`/properties/${match.propertyId}`)}
                className="flex w-full items-center gap-3 rounded-2xl border border-[var(--border)] bg-white p-3 text-left shadow-2xs dark:bg-slate-900"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-bold text-slate-900 dark:text-white">
                    {match.propertyLabel}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-slate-500">
                    {[match.projectName, match.bedrooms ? `${match.bedrooms} BHK` : null]
                      .filter(Boolean).join(' · ') || match.reasons[0] || ''}
                  </span>
                </span>
                {typeof match.price === 'number' && (
                  <span className="shrink-0 text-[13px] font-bold text-[#2563eb]">
                    {formatIndianPrice(match.price)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {tab === 'files' && <Attachments recordId={record.id} moduleName={module} canEdit={canEdit} />}

        {tab === 'details' && blocks.map((block) => (
          <Group key={block.key} title={block.label}>
            {block.fields.map((field) => (
              <Row
                key={field.name}
                title={<span className="text-[13px] font-normal text-muted">{field.label}</span>}
                subtitle={(
                  <span className="text-[16px] text-[var(--text)]">
                    <FieldValue
                      field={field}
                      value={record.values[field.name]}
                      display={record.display?.[field.name]}
                    />
                  </span>
                )}
                onClick={canEdit && !field.isReadonly ? () => {
                  setDraft(record.values[field.name] ?? null);
                  setEditing(field);
                } : undefined}
              />
            ))}
          </Group>
        ))}

        <div style={{ height: 'calc(var(--bottom-nav-h, 0px) + 96px)' }} />
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Writing something down, without leaving the screen.               */}
      {/* ----------------------------------------------------------------- */}
      <QuickNote
        disabled={addNote.isPending}
        onSend={(body) => addNote.mutate(body)}
      />

      {/* One field, one sheet, one save. */}
      <Sheet
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.label ?? ''}
        action={(
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => editing && save.mutate({ [editing.name]: draft })}
            className="rounded-full bg-brand-600 px-4 py-2 text-[15px] font-semibold text-white disabled:opacity-60"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      >
        {editing && (
          <FieldInput
            field={editing}
            value={draft}
            onChange={setDraft}
            recordId={record.id}
            moduleName={module}
          />
        )}
      </Sheet>

      <NoteSheet
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        busy={addNote.isPending}
        onSave={(body) => addNote.mutate(body)}
      />

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={record.label}>
        <div className="-mx-4">
          {record.can?.delete !== false && (
            <Row
              leading={<Trash2 className="h-5 w-5 text-rose-600" />}
              title={<span className="text-rose-600">Delete</span>}
              onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}
            />
          )}
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${record.label}?`}
        body="It stops appearing in lists. An administrator can still bring it back."
        confirmLabel="Delete"
        danger
        onConfirm={() => { setConfirmDelete(false); remove.mutate(); }}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/**
 * The note bar across the foot of the screen — the prototype's last row.
 *
 * *"Callback later"*, *"Budget issue"*, *"Visit scheduled"* are drawn as chips
 * above the box in his mock-up. **They are not written into this file**: they
 * are the `note_snippet` dropdown, editable in Admin → Dropdowns, which is the
 * same list the desktop notes box offers. Three phrases typed into a component
 * is the one thing this CRM is built to avoid, and an empty list simply shows
 * no chips rather than inventing words this business never chose.
 *
 * `appendSnippet` is what adds one: its own line, no blank line at the start,
 * and tapping the same phrase twice adds nothing — three rules a rep would
 * otherwise undo by hand.
 *
 * **There is no microphone.** The prototype draws one; dictation is the
 * keyboard's own button on both Android and iOS, and a second one that does
 * the same thing is a control to explain rather than a feature.
 */
function QuickNote({ disabled, onSend }: {
  disabled: boolean;
  onSend: (body: string) => void;
}): JSX.Element {
  const [body, setBody] = useState('');
  const phrases = useNoteSnippets();

  const send = (): void => {
    const text = body.trim();
    if (!text) return;
    onSend(text);
    setBody('');
  };

  return (
    <div
      className="shrink-0 border-t border-[var(--border)] bg-white px-3 pb-[env(safe-area-inset-bottom)] pt-2 dark:bg-slate-900"
      style={{ marginBottom: 'var(--bottom-nav-h, 0px)' }}
    >
      {phrases.length > 0 && (
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
          {phrases.map((phrase) => (
            <button
              key={phrase}
              type="button"
              onClick={() => setBody((current) => appendSnippet(current, phrase))}
              className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-1.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {phrase}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <label htmlFor="quick-note" className="sr-only">Write a note</label>
        <textarea
          id="quick-note"
          rows={1}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write a note…"
          className="max-h-24 min-h-[40px] flex-1 resize-none rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-[14px] text-slate-800 placeholder-slate-400 focus:border-brand-400 focus:outline-none focus:ring-0 dark:bg-slate-800 dark:text-slate-100"
        />
        <button
          type="button"
          aria-label="Save this note"
          disabled={disabled || !body.trim()}
          onClick={send}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white disabled:opacity-40"
        >
          {disabled ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

/**
 * Photos and documents on the record.
 *
 * A strip rather than a list, because on a property these are almost always
 * photographs and a name like `IMG_4821.HEIC` tells nobody anything. The add
 * tile opens the phone's own picker, which offers the camera and the gallery
 * in one sheet — the OS does that for a plain file input, and doing it any
 * other way risks the EXIF the capture pipeline files photos by.
 */
function Attachments({
  recordId, moduleName, canEdit,
}: { recordId: string; moduleName: string; canEdit: boolean }): JSX.Element | null {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);

  const { data } = useQuery({
    queryKey: ['files', recordId],
    queryFn: () => api.files(recordId),
  });

  const files = ((data ?? []) as unknown as {
    id: string; file_name: string; mime_type: string;
  }[]);

  async function add(list: FileList | null): Promise<void> {
    if (!list?.length) return;
    const chosen = Array.from(list);
    setBusy({ done: 0, total: chosen.length });
    for (const file of chosen) {
      try { await api.uploadFile(file, recordId, moduleName); }
      catch (err) { toast.error(`Could not add ${file.name}`, (err as Error).message); }
      finally { setBusy((b) => (b ? { ...b, done: b.done + 1 } : b)); }
    }
    setBusy(null);
    await queryClient.invalidateQueries({ queryKey: ['files', recordId] });
    void tap();
  }

  if (!canEdit && !files.length) return null;

  return (
    <Group title="Photos and files">
      <div className="flex gap-2 overflow-x-auto p-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {canEdit && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={Boolean(busy)}
            className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[var(--border)] text-muted active:bg-slate-500/10 disabled:opacity-60"
          >
            {busy
              ? <span className="text-[12px] font-medium">{busy.done}/{busy.total}</span>
              : <><ImagePlus className="h-5 w-5" /><span className="text-[11px]">Add</span></>}
          </button>
        )}

        {files.map((file) => (
          <a
            key={file.id}
            href={authedFileUrl(`/api/files/${file.id}`)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              // A webview has nowhere to open a tab. Hand the bytes to the
              // share sheet, which is where a phone user expects to choose
              // what opens them.
              if (isNative) {
                e.preventDefault();
                void downloadFromUrl(authedFileUrl(`/api/files/${file.id}`), file.file_name).catch(() => undefined);
              }
            }}
            className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]"
          >
            {file.mime_type?.startsWith('image/') ? (
              <img
                src={authedFileUrl(`/api/files/${file.id}`, { variant: 'thumb' })}
                alt={file.file_name}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-center text-muted">
                <FileText className="h-5 w-5" />
                <span className="line-clamp-2 text-[10px] leading-tight">{file.file_name}</span>
              </span>
            )}
          </a>
        ))}

        {!canEdit && !files.length && (
          <p className="px-1 py-6 text-[15px] text-muted">Nothing attached yet.</p>
        )}
      </div>

      <input
        ref={input}
        type="file"
        // No `capture` attribute on purpose: without it the OS offers the
        // camera *and* the gallery, which is what somebody standing at a gate
        // and somebody at a desk each need.
        accept="image/*,video/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => { void add(e.target.files); e.target.value = ''; }}
      />
    </Group>
  );
}

/** One of the big round things under the name. */
function Action({ icon, label, onClick }: { icon: JSX.Element; label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => { void tap(); onClick(); }}
      className="flex w-20 flex-col items-center gap-1.5 active:opacity-60"
    >
      {/*
        `bg-brand-50`, not `bg-brand-600/10`. The brand scale is CSS variables,
        and Tailwind's opacity modifier composes a colour it cannot resolve from
        one — so the tint silently did not render and these were bare icons
        floating on the background. Any brand step is safe; an opacity on one is
        not.
      */}
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400">
        {icon}
      </span>
      <span className="text-[12px] font-medium text-brand-600 dark:text-brand-400">{label}</span>
    </button>
  );
}

function NoteSheet({
  open, onClose, onSave, busy,
}: { open: boolean; onClose: () => void; onSave: (body: string) => void; busy: boolean }): JSX.Element {
  const [body, setBody] = useState('');
  return (
    <Sheet
      open={open}
      onClose={() => { setBody(''); onClose(); }}
      title="Add a note"
      action={(
        <button
          type="button"
          disabled={busy || !body.trim()}
          onClick={() => onSave(body.trim())}
          className="rounded-full bg-brand-600 px-4 py-2 text-[15px] font-semibold text-white disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      )}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        placeholder="What was said?"
        className={cn(
          'w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3',
          'text-[16px] outline-none focus:border-brand-500',
        )}
      />
    </Sheet>
  );
}
