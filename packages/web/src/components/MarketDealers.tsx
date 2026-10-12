/**
 * Everyone who posts in the dealer groups. Uploading a group already adds
 * them to Associates (never to Contacts or Inventory); the button here is for
 * catching up after the fact, and it says plainly when the CRM refused one.
 */
import { type JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import { Phone } from 'lucide-react';
import { api } from '../lib/api';
import { Badge, EmptyState, Spinner } from './ui';
import { toast } from '../lib/store';

export default function MarketDealers(): JSX.Element {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['market', 'dealers'], queryFn: api.marketDealers });
  const save = useMutation({
    mutationFn: api.saveMarketDealers,
    onSuccess: (result) => {
      if (result.noModule) {
        toast.error('This CRM has no Associates module', 'Nothing was added.');
        return;
      }
      const bits = [
        `${result.alreadyKnown} already in the CRM`,
        `${result.noLocation} left out for no known locality`,
        result.refused ? `${result.refused} refused (${result.firstRefusal ?? 'see the server log'})` : null,
      ].filter(Boolean);
      toast.success(`${result.created} added to Associates`, bits.join(' · '));
      void refetch();
    },
    onError: (err) => toast.error('Could not add the dealers', (err as Error).message),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-[14rem] flex-1 text-sm text-muted">
          The people posting in your groups. They are added to <strong>Associates</strong> when a group is uploaded — never to Contacts or Inventory.
        </p>
        <button type="button" className="btn-secondary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : null} Add any missing to Associates
        </button>
      </div>
      {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
      {error && <p className="text-sm text-negative">Could not load the dealers: {(error as Error).message}</p>}
      {data && (data.dealers.length === 0 ? (
        <EmptyState title="No dealers yet" body="A dealer appears once a post names a phone number." />
      ) : (
        <>
          <p className="text-xs text-muted">{data.total} dealer{data.total === 1 ? '' : 's'}{data.total > data.dealers.length ? `, busiest ${data.dealers.length} shown` : ''}</p>
          <ul className="space-y-2">
            {data.dealers.map((dealer) => (
              <li key={dealer.phone} className="card flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm">
                <span className="min-w-[10rem] font-semibold">{dealer.name ?? 'Unnamed'}</span>
                <a href={`tel:${dealer.phone}`} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
                  <Phone className="h-3.5 w-3.5" /> {dealer.phone}
                </a>
                <span className="text-xs text-muted">{dealer.posts} post{dealer.posts === 1 ? '' : 's'} · {dealer.haves} offering · {dealer.wants} wanting</span>
                <span className="flex flex-wrap gap-1">{dealer.localities.slice(0, 3).map((place) => <Badge key={place}>{place}</Badge>)}</span>
                <span className="ml-auto text-xs text-muted">{dealer.groups.join(', ')}{dealer.lastSeenAt ? ` · ${relativeTime(dealer.lastSeenAt)}` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      ))}
    </div>
  );
}
