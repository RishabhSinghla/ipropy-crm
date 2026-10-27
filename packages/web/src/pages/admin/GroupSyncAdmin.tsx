import { type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Badge, Skeleton } from '../../components/ui';
import { toast } from '../../lib/store';

/**
 * Which WhatsApp groups the company's linked number may read into Dealer Groups.
 *
 * Every group the number is in is listed, and **every one starts switched off**:
 * the number may also sit in family or personal groups, and nothing from those
 * may be kept. Switching a group on starts the live feed for it (new messages
 * arrive by themselves, no export, no upload). "Read earlier messages" fetches
 * what the group said before today, slowly, one group at a time.
 */
export default function GroupSyncAdmin(): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['wa-biz', 'groups'],
    queryFn: () => api.waGroups(),
    // Fast while a history read is running so the progress is visible, calm otherwise.
    refetchInterval: (query) => (query.state.data?.history.running ? 3_000 : 30_000),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['wa-biz', 'groups'] });
  const onError = (err: unknown): void => toast.error('Group sync', err instanceof Error ? err.message : 'Something went wrong');

  const fetchList = useMutation({
    mutationFn: () => api.waGroupsRefresh(),
    onSuccess: (r) => { toast.success('Groups loaded', `${r.total} groups, ${r.added} new (switched off).`); void refresh(); },
    onError,
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.waGroupSet(v.id, v.enabled),
    onSuccess: () => void refresh(),
    onError,
  });
  const enableAll = useMutation({
    mutationFn: () => api.waGroupsEnableAll(),
    onSuccess: (r) => { toast.success('Groups switched on', `${r.enabled} groups will now feed Dealer Groups.`); void refresh(); },
    onError,
  });
  const history = useMutation({
    mutationFn: (groupId?: string) => api.waGroupsHistory(groupId),
    onSuccess: (r) => {
      if (r.started) toast.info('Reading earlier messages', 'One group at a time, with a pause between each.');
      else toast.error('Not started', r.reason ?? '');
      void refresh();
    },
    onError,
  });

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-96 w-full" /></div>;
  if (error || !data) {
    return (
      <div className="p-4 sm:p-6">
        <div className="card p-4 text-sm">
          Group sync could not be loaded: {error instanceof Error ? error.message : 'unknown error'}. Only administrators can open this page.
        </div>
      </div>
    );
  }

  const { groups, history: job } = data;
  const on = groups.filter((g) => g.enabled).length;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="card p-4">
        <h2 className="text-base font-semibold">Dealer groups from WhatsApp</h2>
        <p className="mt-1 text-sm text-muted">
          Groups you switch on are read live into <strong>Dealer Groups</strong> — only messages that look like a property
          deal or requirement are kept, and a message never appears twice. Groups left off are never read, so family and
          personal groups stay private. Photos and voice notes are ignored.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn-secondary btn-sm" disabled={fetchList.isPending} onClick={() => fetchList.mutate()}>
            {fetchList.isPending ? 'Asking WhatsApp…' : 'Load my groups from WhatsApp'}
          </button>
          <button
            className="btn-secondary btn-sm"
            disabled={enableAll.isPending || groups.length === on}
            onClick={() => { if (window.confirm('Switch on every group in this list? Anything in them that looks like a deal will be kept.')) enableAll.mutate(); }}
          >
            Switch on all groups
          </button>
          <button className="btn-primary btn-sm" disabled={job.running || on === 0 || history.isPending} onClick={() => history.mutate(undefined)}>
            Read earlier messages of all switched-on groups
          </button>
          <span className="text-xs text-muted">{on} of {groups.length} groups on</span>
        </div>
        {job.running && (
          <p className="mt-2 text-sm" role="status">
            Reading earlier messages… {job.done} of {job.total} groups done. This is deliberately slow, to keep the number safe.
          </p>
        )}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="list-head">
            <tr>
              <th className="px-3 py-2 text-left">On</th>
              <th className="px-3 py-2 text-left">Group</th>
              <th className="px-3 py-2 text-left">Messages read live</th>
              <th className="px-3 py-2 text-left">Earlier messages</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted">
                No groups yet. Press “Load my groups from WhatsApp” once the number is linked.
              </td></tr>
            )}
            {groups.map((g) => (
              <tr key={g.id} className="border-t border-[var(--border)]">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Read ${g.name || 'this group'} into Dealer Groups`}
                    checked={g.enabled}
                    disabled={toggle.isPending || (!g.enabled && !g.name)}
                    onChange={(e) => toggle.mutate({ id: g.id, enabled: e.target.checked })}
                  />
                </td>
                <td className="px-3 py-2 font-medium">{g.name || <span className="text-muted">(no name yet)</span>}</td>
                <td className="px-3 py-2">
                  {g.enabled ? `${g.messagesSeen.toLocaleString('en-IN')}${g.lastMessageAt ? ` · last ${new Date(g.lastMessageAt).toLocaleString('en-IN')}` : ''}` : <span className="text-muted">off</span>}
                </td>
                <td className="px-3 py-2">
                  {g.historyState === 'done' && (
                    <>
                      <Badge>Done</Badge>
                      <button className="btn-secondary btn-sm ml-2" disabled={job.running} onClick={() => history.mutate(g.id)}>Read again</button>
                    </>
                  )}
                  {g.historyState === 'running' && <Badge>Reading…</Badge>}
                  {g.historyState === 'failed' && (
                    <>
                      <span className="text-negative" title={g.historyNote ?? ''}>Failed — {g.historyNote}</span>
                      <button className="btn-secondary btn-sm ml-2" disabled={job.running} onClick={() => history.mutate(g.id)}>Read again</button>
                    </>
                  )}
                  {g.historyState === 'none' && g.enabled && (
                    <button className="btn-secondary btn-sm" disabled={job.running} onClick={() => history.mutate(g.id)}>Read earlier messages</button>
                  )}
                  {g.historyNote && g.historyState === 'done' && <span className="ml-2 text-xs text-muted">{g.historyNote}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
