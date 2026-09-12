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
import { type JSX, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { FieldMeta, LayoutConfig, RecordEnvelope } from '@ipropy/shared';
import { relativeTime, toInternational } from '@ipropy/shared';
import { MessageCircle, MoreVertical, Phone, StickyNote, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { dial, openExternal, tap } from '../lib/nativeActions';
import { invalidateRecordQueries } from '../lib/invalidate';
import { FieldInput, FieldValue } from '../components/FieldRenderer';
import { ConfirmDialog, Spinner } from '../components/ui';
import { AppBar, Avatar, BarButton, Group, Row, Sheet } from './primitives';

export default function MobileRecord(): JSX.Element {
  const { module = '', id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<FieldMeta | null>(null);
  const [draft, setDraft] = useState<unknown>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]">
      <AppBar
        title={record.label}
        onBack={() => navigate(-1)}
        actions={(
          <BarButton icon={<MoreVertical className="h-5 w-5" />} label="More" onClick={() => setMenuOpen(true)} />
        )}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* Who this is. */}
        <div className="flex flex-col items-center px-6 pb-5 pt-3">
          <Avatar name={record.label} size={88} />
          <h1 className="mt-3 text-center text-[24px] font-semibold leading-tight">{record.label}</h1>
          {/*
            The formatted value the server already produced, not the raw
            international string — one reads "+91 9186 066374" and the other
            "+919186066374", and they were sitting two lines apart looking like
            two different numbers.
          */}
          {phone && <p className="mt-1 text-[15px] text-muted">{phoneDisplay ?? phone}</p>}
        </div>

        {/* What you would do about them. */}
        <div className="flex justify-center gap-3 px-4 pb-5">
          {phone && <Action icon={<Phone className="h-5 w-5" />} label="Call" onClick={() => dial(phone)} />}
          {phone && (
            <Action
              icon={<MessageCircle className="h-5 w-5" />}
              label="WhatsApp"
              onClick={() => void openExternal(`https://wa.me/${phone.replace(/[^\d+]/g, '')}`)}
            />
          )}
          <Action icon={<StickyNote className="h-5 w-5" />} label="Note" onClick={() => setNoteOpen(true)} />
        </div>

        {blocks.map((block) => (
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

        {(timeline?.length ?? 0) > 0 && (
          <Group title="Activity">
            {(timeline ?? []).slice(0, 30).map((entry, i) => (
              <Row
                key={`${entry.type}-${entry.at}-${i}`}
                title={entry.title ?? entry.type}
                subtitle={[entry.body, relativeTime(entry.at)].filter(Boolean).join(' · ')}
              />
            ))}
          </Group>
        )}

        <div style={{ height: 'calc(var(--bottom-nav-h, 0px) + 32px)' }} />
      </div>

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
