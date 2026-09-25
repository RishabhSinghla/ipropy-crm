import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { RecordEnvelope } from '@ipropy/shared';
import { api } from '../lib/api';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import { FieldBlock, NotesPanel } from './RecordBlocks';
import { Skeleton } from './ui';

/**
 * The whole contact, beside the conversation.
 *
 * **20 September 2026, the owner:** *"I do not need it there instead all
 * those details … I do not want to switch screen during whatsapp chat and
 * then and there I want all info of that record everything in the right
 * pane."*
 *
 * The pane used to hold two summary cards and a link to the record, so
 * answering "what is their budget" meant leaving the chat, reading it, and
 * coming back — by which time the customer has sent two more messages. Now it
 * is the record itself: the same field cards and the same notes box the split
 * view renders, from the same components, every value typed in where it
 * stands.
 *
 * **Nothing here names a field.** The cards come from `useRecordPanes`, which
 * reads Admin → Split View first and the Layout Designer second, so an admin
 * who rearranges a module rearranges this pane too and nobody has to deploy.
 * A screen that named `budget` or `unit_number` itself would freeze those
 * into a release, which is the one rule this CRM is built around.
 */
export function useChatRecord(moduleName: string | null, recordId: string | null): {
  module: DescribedModule | undefined; record: RecordEnvelope | undefined; loading: boolean;
  /** The record could not be fetched — gone, not this module, or not yours. */
  failed: boolean;
} {
  const { data: module } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName!),
    enabled: Boolean(moduleName),
  });
  /*
    The same query key the record page and the split view use, so opening a
    chat warms the record and opening the record warms the chat — and an edit
    made in one is invalidated for both.
  */
  const { data: record, isLoading, isError } = useQuery({
    queryKey: ['record', moduleName, recordId],
    queryFn: () => api.record(moduleName!, recordId!),
    enabled: Boolean(moduleName && recordId),
    // A record that is not there will not be there on the third try either.
    retry: false,
  });
  return { module: module as DescribedModule | undefined, record, loading: isLoading, failed: isError };
}

export function ChatRecordPane({ module, record }: {
  module: DescribedModule; record: RecordEnvelope;
}): JSX.Element {
  const { blocks } = useRecordPanes(module);
  const canEdit = record.can?.edit ?? module.permissions.edit;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/*
        The way out, kept small. Everything worth reading is on this pane now,
        so the link is for the things that are not — the timeline, the files,
        the matching inventory — rather than the first thing somebody reaches
        for.
      */}
      <Link
        to={`/${module.name}/${record.id}`}
        className="inline-flex items-center gap-1.5 self-start rounded-lg px-1 py-0.5 text-2xs font-semibold text-muted transition-colors hover:text-brand-600"
      >
        <ExternalLink className="h-3 w-3" />
        Open the full record
      </Link>

      {blocks.map((block) => (
        <FieldBlock
          key={block.key}
          module={module}
          title={block.label}
          columns={1}
          fields={block.fields}
          row={record}
          canEdit={canEdit}
        />
      ))}

      <NotesPanel module={module.name} record={record} />
    </div>
  );
}

/** While the record loads, so the pane never jumps from empty to full. */
export function ChatRecordPaneSkeleton(): JSX.Element {
  return (
    <div className="space-y-3">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
