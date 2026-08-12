/**
 * Making a link and sending it.
 *
 * The job this replaces is selecting forty photos in WhatsApp, so the whole
 * thing has to be shorter than that or nobody switches. Open, type a name,
 * tap Send on WhatsApp. The name is optional and the link works without it —
 * but naming it is what turns an anonymous counter into "the one I sent Rajesh
 * has been opened four times", which is the part a dealer actually wants.
 *
 * Links already made are listed underneath, because the second question after
 * "send this" is always "did they look at it?".
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, Link2, MessageCircle, Trash2 } from 'lucide-react';
import { api, type ShareLink } from '../lib/api';
import { toast } from '../lib/store';
import { relativeTime } from '@ipropy/shared';
import { EmptyState, Spinner } from './ui';

/** Absolute, because it is going into a message on somebody else's phone. */
const linkUrl = (token: string): string => `${window.location.origin}/s/${token}`;

export function ShareLinksPanel({
  module, recordId,
}: { module: string; recordId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const { data: links, isLoading } = useQuery({
    queryKey: ['share-links', module, recordId],
    queryFn: () => api.shareLinks(module, recordId),
    retry: false,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['share-links', module, recordId] });
  };

  const create = useMutation({
    mutationFn: () => api.createShareLink(module, recordId, label.trim() ? { label: label.trim() } : {}),
    onSuccess: async (link) => {
      setLabel('');
      invalidate();
      await copy(link.token);
    },
    onError: (err: Error) => toast.error('Could not make a link', err.message),
  });

  const revoke = useMutation({
    mutationFn: (linkId: string) => api.revokeShareLink(module, recordId, linkId),
    onSuccess: () => {
      invalidate();
      toast.info('Link turned off', 'Anyone opening it now sees nothing.');
    },
    onError: (err: Error) => toast.error('Could not turn off the link', err.message),
  });

  const copy = async (token: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(linkUrl(token));
      setCopied(token);
      window.setTimeout(() => setCopied((c) => (c === token ? null : c)), 2000);
    } catch {
      // Clipboard access is refused over plain HTTP and in some in-app
      // browsers. Saying so is better than a button that silently does nothing.
      toast.info('Copy it by hand', linkUrl(token));
    }
  };

  const live = (links ?? []).filter((l) => !l.revokedAt);
  const closed = (links ?? []).filter((l) => l.revokedAt);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="share-label">
          Who is this for?
        </label>
        <div className="flex gap-2">
          <input
            id="share-label"
            className="input flex-1"
            placeholder="Rajesh (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !create.isPending) create.mutate(); }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Spinner className="h-4 w-4" /> : 'Make a link'}
          </button>
        </div>
        <p className="text-xs text-muted">
          The name is only for you — whoever opens the link never sees it. Anyone with the link can
          see this property&apos;s photos and details, so send it to one person at a time.
        </p>
      </div>

      {isLoading ? (
        <Spinner className="h-4 w-4" />
      ) : !links?.length ? (
        <EmptyState
          icon={<Link2 className="h-8 w-8" />}
          title="No links yet"
          body="Make one to send this property on WhatsApp without attaching a single photo."
        />
      ) : (
        <div className="space-y-3">
          {live.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              copied={copied === link.token}
              onCopy={() => void copy(link.token)}
              onRevoke={() => revoke.mutate(link.id)}
              revoking={revoke.isPending}
            />
          ))}

          {closed.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">
                {closed.length} turned off
              </summary>
              <ul className="mt-2 space-y-1">
                {closed.map((link) => (
                  <li key={link.id} className="flex items-center gap-2 text-xs text-muted">
                    <span className="flex-1 truncate">{link.label ?? 'Unnamed link'}</span>
                    <span>{link.viewCount} {link.viewCount === 1 ? 'view' : 'views'}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function LinkRow({
  link, copied, onCopy, onRevoke, revoking,
}: {
  link: ShareLink;
  copied: boolean;
  onCopy: () => void;
  onRevoke: () => void;
  revoking: boolean;
}): JSX.Element {
  const url = linkUrl(link.token);
  // wa.me opens the app on a phone and web on a desktop, with the message
  // pre-filled and no recipient — so the sender picks the contact themselves
  // and nothing is sent without them tapping send.
  // Never put the CRM record label into the message: it commonly contains a
  // house or unit number that the admin intentionally hid from the share page.
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`Property details from iPropy\n${url}`)}`;

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{link.label ?? 'Unnamed link'}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Eye className="h-3 w-3 shrink-0" />
            {link.viewCount === 0
              ? 'Not opened yet'
              : `Opened ${link.viewCount} ${link.viewCount === 1 ? 'time' : 'times'}`}
            {link.lastViewedAt && ` · last ${relativeTime(link.lastViewedAt)}`}
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost btn-sm text-negative"
          onClick={onRevoke}
          disabled={revoking}
          aria-label={`Turn off the link for ${link.label ?? 'this link'}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="mt-2 truncate rounded bg-subtle px-2 py-1 font-mono text-xs text-muted">{url}</p>

      <div className="mt-2 flex gap-2">
        <button type="button" className="btn-ghost btn-sm flex-1" onClick={onCopy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a
          href={whatsapp}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost btn-sm flex-1"
        >
          <MessageCircle className="h-3.5 w-3.5" />
          WhatsApp
        </a>
      </div>
    </div>
  );
}
