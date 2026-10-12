/**
 * One dealer-group message, in full.
 *
 * The cards show a property's own few lines. A rep deciding whether to ring needs
 * the rest — the dealer's exact words, the details the reading missed, who sent it
 * and where — so every card opens this. The property the card was about is marked
 * in the message, and the other properties read out of the same message are listed
 * under it, because a broker's post is often twenty plots and the card is one.
 */
import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatIndianPrice, relativeTime } from '@ipropy/shared';
import { MessageCircle, Phone } from 'lucide-react';
import { api, type MarketPostDetail } from '../lib/api';
import { openExternal } from '../lib/nativeActions';
import { Badge, Modal, Spinner } from './ui';

export interface MessageToShow {
  postId: string;
  body: string;
  posterName: string | null;
  posterPhone: string | null;
  groups: string[];
  postedAt: string | null;
  /** The lines of the property this was opened from, to be marked in the message. */
  highlight?: string;
}

const QUADRANT = (kind: string, purpose: string): string =>
  kind === 'have' ? (purpose === 'rent' ? 'For Rent' : 'For Sale') : (purpose === 'rent' ? 'Tenant Requirement' : 'Buyer Requirement');

function priceText(min: number | null, max: number | null): string | null {
  if (min === null) return null;
  const low = formatIndianPrice(min * 100_000);
  return max === null || max === min ? low : `${low} – ${formatIndianPrice(max * 100_000)}`;
}

/** The message's lines, with the ones that belong to the property being looked at marked. */
function MessageText({ body, highlight }: { body: string; highlight?: string }): JSX.Element {
  const marked = new Set((highlight ?? '').split('\n').map((line) => line.trim()).filter((line) => line.length > 3));
  return (
    <div className="max-h-[48vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm leading-relaxed" data-testid="full-message">
      {body.split('\n').map((line, index) => (
        <span key={index} className={marked.has(line.trim()) ? 'rounded bg-brand-100 px-0.5 font-semibold dark:bg-brand-900/40' : undefined}>
          {line}
          {'\n'}
        </span>
      ))}
    </div>
  );
}

function Detail({ detail }: { detail: MarketPostDetail }): JSX.Element {
  return (
    <>
      {detail.listings.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {detail.listings.length === 1 ? 'The property in this message' : `${detail.listings.length} properties in this message`}
          </h3>
          <ul className="space-y-1">
            {detail.listings.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge color={item.kind === 'have' ? '#16a34a' : '#2563eb'}>{QUADRANT(item.kind, item.purpose)}</Badge>
                <span className="font-semibold">
                  {[item.category, item.bhk ? `${item.bhk} BHK` : null, item.sizeSqYd ? `${item.sizeSqYd} yd` : null].filter(Boolean).join(' · ') || 'Property'}
                </span>
                {item.places.length > 0 && <span className="text-muted">{item.places.join(', ')}</span>}
                {priceText(item.priceMinLakh, item.priceMaxLakh) && <span className="font-semibold">{priceText(item.priceMinLakh, item.priceMaxLakh)}{item.purpose === 'rent' ? ' / month' : ''}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {detail.sightings.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Where it was posted</h3>
          <ul className="space-y-0.5 text-xs text-muted">
            {detail.sightings.map((seen, index) => (
              <li key={index}>
                <span className="font-medium text-[var(--text)]">{seen.group}</span>
                {seen.sender ? ` · ${seen.sender}` : ''}
                {seen.postedAt ? ` · ${relativeTime(seen.postedAt)}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function DealMessageDialog({ message, onClose }: { message: MessageToShow | null; onClose: () => void }): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['market', 'post', message?.postId],
    queryFn: () => api.marketPostDetail(message!.postId),
    enabled: Boolean(message),
    staleTime: 60_000,
  });
  return (
    <Modal open={Boolean(message)} onClose={onClose} title="Full message" size="lg">
      {message && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-semibold">{message.posterName ?? data?.sightings[0]?.sender ?? data?.post.posterName ?? 'Unknown sender'}</span>
            <span className="text-xs text-muted">
              {message.groups.join(', ')}{message.postedAt ? ` · ${relativeTime(message.postedAt)}` : ''}
            </span>
            {(message.posterPhone ?? data?.post.posterPhone) && (
              <span className="ml-auto flex gap-2">
                <a href={`tel:${message.posterPhone ?? data?.post.posterPhone}`} className="btn-secondary inline-flex items-center gap-1.5">
                  <Phone className="h-4 w-4" /> {message.posterPhone ?? data?.post.posterPhone}
                </a>
                <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => void openExternal(`https://wa.me/91${message.posterPhone ?? data?.post.posterPhone}`)}>
                  <MessageCircle className="h-4 w-4" /> WhatsApp
                </button>
              </span>
            )}
          </div>
          <MessageText body={message.body} highlight={message.highlight} />
          {isLoading && <div className="flex justify-center"><Spinner /></div>}
          {data && <Detail detail={data} />}
        </div>
      )}
    </Modal>
  );
}
