/**
 * The two pills beside a record's name: where it stands, and how the last
 * call went.
 *
 * **26 September 2026, the owner**, of both modules: *"From the Left of Icon
 * Star/Favourite i need these button on both module buy side by side"* — one
 * carrying the module's own status, *"colour Picked from Leads/Inventory
 * Status Dropdown Colour"*, and one for calling back, *"Colour Always Fix
 * With Dark Purple as theme button"*. Both show a dropdown arrow and open the
 * list behind them.
 *
 * **No screen names a field here either.** The status pill is whatever
 * `pipelineFieldOf` says this module's stage field is — Lead Status on a
 * contact, Property Status on a unit — and its options and their colours come
 * off that field's own metadata, so an admin who adds a stage or recolours one
 * sees it here the same afternoon. The call pill reads the admin's own
 * `call_disposition` list through `useCallDispositions`, which is the list the
 * server checks a save against.
 *
 * One component, used by the split view and the record page, so the two cannot
 * drift into showing different things in the same place.
 */
import { type JSX, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';
import type { FieldMeta, RecordEnvelope } from '@ipropy/shared';
import { Dropdown, DropdownItem } from './ui';
import { api } from '../lib/api';
import { useCallDispositions } from '../lib/callDispositions';
import { followUpFor } from '../lib/callConsole';
import { badgeVars } from '../lib/color';
import { invalidateRecordQueries } from '../lib/invalidate';
import { type DescribedModule, useRecordPanes } from '../lib/recordPanes';
import { optionsWithValue } from '../lib/picklistOptions';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';

export function HeaderPills({ module, row, canEdit, className }: {
  module: DescribedModule;
  row: RecordEnvelope;
  canEdit: boolean;
  className?: string;
}): JSX.Element | null {
  /*
    Which field is the stage and which is the chase date is `useRecordPanes`'s
    decision, not this component's — the same one the record header, the split
    view and the chat pane already read. A module with no stage field has no
    stage to show, so the pair does not appear rather than guessing at a field
    whose name happens to contain "status".
  */
  const { statusField, followUpField } = useRecordPanes(module);
  if (!statusField) return null;
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5', className)}>
      <StatusPill module={module} field={statusField} row={row} canEdit={canEdit} />
      <CallAgainPill module={module} followUp={followUpField} row={row} canEdit={canEdit} />
    </span>
  );
}

/**
 * Where this record stands, in the colour the admin chose for that stage.
 *
 * **26 September 2026, the owner:** *"it should be Normal editable Rounded
 * chip in dark color as we picked from Master Dropdown colors, Its shold be
 * very bold and highlighted then all text eye catching."* So it is the
 * **solid** variant — the admin's hue as the fill rather than as a wash of
 * itself — which `lib/color.ts` already computes beside the tinted one, with
 * black or white on top chosen so the pair still clears AA. Which of those it
 * picks is why a raw `${color}18` written here would not do: that lands
 * around 2–3:1, and how readable a stage came out would depend entirely on
 * which colour somebody happened to choose.
 *
 * **No arrow**, on the same instruction. It is still the same control — the
 * whole chip opens the list — and a chevron on a chip this size ate a third
 * of the word inside it.
 */
function StatusPill({ module, field, row, canEdit }: {
  module: DescribedModule; field: FieldMeta; row: RecordEnvelope; canEdit: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const value = row.values[field.name];
  const current = value === null || value === undefined ? '' : String(value);

  const options = useMemo(
    () => optionsWithValue(field.options?.filter((o) => o.isActive || o.value === current), current),
    [field.options, current],
  );

  const set = useMutation({
    mutationFn: (next: string) => api.update(module.name, row.id, { [field.name]: next }),
    onSuccess: () => {
      invalidateRecordQueries(queryClient, module.name, row.id);
      toast.success('Status updated');
    },
    onError: (err: Error) => toast.error('Could not change the status', err.message),
  });

  const chosen = options.find((o) => o.value === current);
  const label = chosen?.label ?? current ?? '';

  return (
    <Dropdown
      align="right"
      trigger={
        <button
          type="button"
          disabled={!canEdit || set.isPending}
          data-testid="status-pill"
          title={`${field.label}${label ? `: ${label}` : ''} — change it`}
          aria-label={`${field.label}${label ? `, ${label}` : ', not set'}. Change it`}
          style={badgeVars(chosen?.color)}
          className={cn(
            'inline-flex h-8 max-w-[12rem] items-center rounded-full px-3.5 text-sm font-extrabold tracking-tight',
            'shadow-sm transition-transform hover:brightness-110 active:scale-95',
            'disabled:cursor-not-allowed disabled:opacity-60',
            // A stage nobody has given a colour falls back to the brand rather
            // than to an invented hue — still dark, still eye-catching.
            chosen?.color ? 'badge-solid' : 'bg-brand-700 text-white',
          )}
        >
          <span className="truncate">{label || field.label}</span>
        </button>
      }
    >
      {(close) => (
        <>
          {options.map((option) => (
            <DropdownItem
              key={option.value}
              onClick={() => { close(); if (option.value !== current) set.mutate(option.value); }}
              icon={
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: option.color ?? 'var(--border)' }}
                  aria-hidden
                />
              }
            >
              {option.label}
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  );
}

/**
 * How the last call went, and one tap to record how this one did.
 *
 * Dark purple whatever the outcome — the owner asked for the theme colour
 * fixed here, which is also the right call: the stage pill beside it is the
 * one carrying meaning in its colour, and two coloured pills side by side
 * would leave neither saying anything.
 *
 * Choosing an outcome writes a call the ordinary way, through the same
 * `logCall` the call deck saves with, and lets the outcome set the chase date
 * through `followUpFor` — which never overwrites a date somebody has already
 * put in the future. So a rep who rang from their own handset records what
 * happened without opening anything.
 */
function CallAgainPill({ module, followUp, row, canEdit }: {
  module: DescribedModule; followUp: FieldMeta | undefined; row: RecordEnvelope; canEdit: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  // The same key and the same request the record's Calls tab uses, so opening
  // one warms the other and a call recorded here shows there immediately.
  const { data: calls } = useQuery({
    queryKey: ['record-calls', row.id],
    queryFn: () => api.calls({ recordId: row.id, limit: 1 }),
    staleTime: 30_000,
  });
  const last = (calls ?? [])[0] as { disposition?: string | null } | undefined;
  const outcomes = useCallDispositions(last?.disposition ?? undefined);

  const record = useMutation({
    mutationFn: async (outcome: string) => {
      await api.logCall({
        recordId: row.id,
        module: module.name,
        direction: 'outbound',
        durationSeconds: 0,
        disposition: outcome,
      });
      // The outcome chases them for you, and never argues with a date that is
      // already in the future — the same rule the call deck saves under.
      const chaseOn = followUp
        ? followUpFor(outcome, (row.values[followUp.name] as string | null | undefined) ?? null, new Date())
        : null;
      if (chaseOn && followUp) await api.update(module.name, row.id, { [followUp.name]: chaseOn });
      return chaseOn;
    },
    onSuccess: (chaseOn) => {
      invalidateRecordQueries(queryClient, module.name, row.id);
      void queryClient.invalidateQueries({ queryKey: ['record-calls', row.id] });
      void queryClient.invalidateQueries({ queryKey: ['calls'] });
      toast.success('Call recorded', chaseOn ? 'Follow-up scheduled.' : 'One conversation moved forward.');
    },
    onError: (err: Error) => toast.error('Could not record the call', err.message),
  });

  const label = last?.disposition ? String(last.disposition) : 'Call Again';

  return (
    <Dropdown
      align="right"
      trigger={
        <button
          type="button"
          disabled={!canEdit || record.isPending}
          data-testid="call-again-pill"
          title={last?.disposition ? `Last call: ${label} — record another` : 'Record how a call went'}
          aria-label={last?.disposition ? `Last call ${label}. Record how a call went` : 'Record how a call went'}
          className={cn(
            'inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-full bg-brand-800 px-3.5 text-sm font-extrabold tracking-tight text-white',
            'shadow-sm transition-transform hover:bg-brand-900 active:scale-95',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          <PhoneCall className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      }
    >
      {(close) => (
        <>
          {outcomes.map((outcome) => (
            <DropdownItem key={outcome} onClick={() => { close(); record.mutate(outcome); }}>
              {outcome}
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  );
}
