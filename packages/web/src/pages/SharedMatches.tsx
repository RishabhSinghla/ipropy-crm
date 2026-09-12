/**
 * The units a rep picked, as their customer sees them.
 *
 * One page, several units, no sign-in — the thing somebody actually wants to
 * send after going through a matching list and choosing six. A single-property
 * link already existed and is still the right thing for one floor; sending six
 * of those is six messages and no way to compare them.
 *
 * What a visitor may read is not decided here. Every unit came through
 * `loadSharedProperty` on the server, which applies the admin's own "what a
 * buyer sees" field list, so switching a field off in Admin → Settings → Share
 * links switches it off on this page too without this file knowing which
 * fields those are. The same reason the title and the price arrive resolved
 * rather than looked up by name: the two names this page would have guessed at
 * are both fields production has deleted.
 *
 * Every failure — revoked, expired, mistyped, a unit deleted since — lands on
 * one message, because distinguishing them tells somebody probing for links
 * that they found a real one.
 */
import { type JSX, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { formatIndianPrice } from '@ipropy/shared';
import { api } from '../lib/api';
import { Skeleton } from '../components/ui';

/** A heading for a unit whose name field is blank. */
function title(item: { title: string | null; property: Record<string, unknown> }): string {
  if (item.title) return item.title;
  const bedrooms = str(item.property.bedrooms);
  return [bedrooms ? `${bedrooms} BHK` : null, str(item.property.property_type), str(item.property.locality)]
    .filter(Boolean)
    .join(' · ') || 'Property';
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export default function SharedMatchesPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [lightbox, setLightbox] = useState<{ item: number; photo: number } | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['shared-matches', token],
    queryFn: () => api.sharedMatches(token!),
    enabled: Boolean(token),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <Skeleton className="h-8 w-1/2" />
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
      </div>
    );
  }

  if (isError || !data?.items?.length) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <Building2 className="h-10 w-10 text-muted" />
        <h1 className="text-lg font-semibold">This link is no longer available</h1>
        <p className="text-sm text-muted">
          It may have been turned off, or it may have expired. Ask whoever sent it for a new one.
        </p>
      </div>
    );
  }

  const open = lightbox ? data.items[lightbox.item] : null;

  return (
    <div className="min-h-screen bg-slate-50 pb-12 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white px-4 py-4 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-lg font-semibold tracking-tight">
            {data.items.length} {data.items.length === 1 ? 'property' : 'properties'} for you
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Shared on {new Date(data.sharedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {data.items.map((item, itemIndex) => (
          <article key={item.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            {item.photos.length > 0 && (
              <div className="flex gap-1 overflow-x-auto">
                {item.photos.map((photo, photoIndex) => (
                  <button
                    key={photo.id}
                    onClick={() => setLightbox({ item: itemIndex, photo: photoIndex })}
                    className="shrink-0"
                    aria-label={`Photo ${photoIndex + 1} of ${item.title}`}
                  >
                    <img
                      src={`${photo.url}?size=medium`}
                      alt=""
                      loading="lazy"
                      className="h-40 w-56 object-cover sm:h-48 sm:w-64"
                    />
                  </button>
                ))}
              </div>
            )}

            <div className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                {/* A unit whose name field is empty still needs a heading.
                    The server resolves the title from the module's own
                    `labelFields` and honestly answers null when there is
                    nothing there, so the fallback is built from what the
                    buyer can see — the same shape the single-property page
                    uses. */}
                <h2 className="text-base font-semibold">{title(item)}</h2>
                {/* A unit with no price reads as "on request" rather than ₹0 —
                    an unpriced unit is the normal state of a floor somebody
                    photographed this morning, not a free one. */}
                <span className="text-base font-semibold text-brand-700 dark:text-brand-300">
                  {item.priceShared && item.price ? formatIndianPrice(item.price) : 'Price on request'}
                </span>
              </div>

              <dl className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {item.fields.map((field) => {
                  const value = str(item.property[field.name]);
                  if (!value) return null;
                  return (
                    <div key={field.name} className="flex items-baseline gap-2 text-sm">
                      <dt className="shrink-0 text-xs text-muted">{field.label}</dt>
                      <dd className="min-w-0 flex-1 truncate font-medium">{value}</dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </article>
        ))}
      </div>

      {open && lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`${open.title}, photo ${lightbox.photo + 1} of ${open.photos.length}`}
          onClick={() => setLightbox(null)}
        >
          <button className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white" aria-label="Close" onClick={() => setLightbox(null)}>
            <X className="h-5 w-5" />
          </button>
          {lightbox.photo > 0 && (
            <button
              className="absolute left-4 rounded-full bg-white/10 p-2 text-white"
              aria-label="Previous photo"
              onClick={(e) => { e.stopPropagation(); setLightbox({ ...lightbox, photo: lightbox.photo - 1 }); }}
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          <img
            src={open.photos[lightbox.photo]?.url}
            alt=""
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.photo < open.photos.length - 1 && (
            <button
              className="absolute right-4 rounded-full bg-white/10 p-2 text-white"
              aria-label="Next photo"
              onClick={(e) => { e.stopPropagation(); setLightbox({ ...lightbox, photo: lightbox.photo + 1 }); }}
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
