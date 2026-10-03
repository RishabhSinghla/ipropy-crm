/**
 * "Asha asked you for this record" — and the two buttons that answer it.
 *
 * **3 October 2026, the owner:** *"he can ask to actual owner of record for the
 * permission to assigned him, Now The actual user can change the owner of
 * record."*
 *
 * It sits on the record itself rather than in a queue of its own, because that
 * is where the decision is actually made: the owner opens the record, sees who
 * is asking and why, and hands it over or keeps it. A separate approvals screen
 * would be one more place to remember to look.
 *
 * **Granting is the ordinary reassignment.** The server writes the new owner
 * through `recordService`, so the audit trail reads exactly as it would if the
 * owner had used the assignment field by hand — there is no second way to
 * change who a record belongs to.
 */
import { type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { invalidateRecordQueries } from '../lib/invalidate';
import { toast } from '../lib/store';
import { Avatar } from './ui';

export function AccessRequestBanner({ module, recordId }: { module: string; recordId: string }): JSX.Element | null {
  const queryClient = useQueryClient();
  /*
    The server answers an empty list to anybody who is not this record's owner
    or an admin, so a rep who can merely *read* the record is never told who
    else wants it. The query runs for everybody and draws nothing for most —
    which is cheaper than a screen deciding who is allowed to ask.
  */
  const { data: requests } = useQuery({
    queryKey: ['access-requests', recordId],
    queryFn: () => api.accessRequestsFor(recordId),
    staleTime: 30_000,
  });

  const answer = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'grant' | 'decline' }) => api.answerAccessRequest(id, decision),
    onSuccess: (_result, { decision }) => {
      void queryClient.invalidateQueries({ queryKey: ['access-requests', recordId] });
      // Granting changes who owns the record, so every list and the record
      // itself have to be re-read — the id matters, or the header this banner
      // sits in keeps showing the old owner.
      if (decision === 'grant') invalidateRecordQueries(queryClient, module, recordId);
      toast.success(decision === 'grant' ? 'Handed over' : 'Kept');
    },
    onError: (error: Error) => toast.error('Could not answer that', error.message),
  });

  if (!requests?.length) return null;
  return (
    <div className="space-y-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950/40" data-testid="access-request-banner">
      {requests.map((request) => (
        <div key={request.id} className="flex flex-wrap items-center gap-2">
          <Avatar name={request.requesterName ?? 'Colleague'} size={22} />
          <p className="min-w-0 flex-1 text-xs text-amber-900 dark:text-amber-100">
            <strong className="font-semibold">{request.requesterName ?? 'A colleague'}</strong> asked for this record.
            {request.note && <span className="text-muted"> “{request.note}”</span>}
          </p>
          <button
            type="button"
            className="btn-primary btn-sm shrink-0"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ id: request.id, decision: 'grant' })}
          >
            <UserPlus className="h-3.5 w-3.5" />
            Assign to {request.requesterName?.split(' ')[0] ?? 'them'}
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm shrink-0"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ id: request.id, decision: 'decline' })}
          >
            Keep it
          </button>
        </div>
      ))}
    </div>
  );
}
