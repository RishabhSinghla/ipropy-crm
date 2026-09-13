/**
 * The units a rep picked, as their customer sees them.
 *
 * One page, several units, no sign-in — the thing somebody actually wants to
 * send after going through a matching list and choosing six. A single-property
 * link already existed and is still the right thing for one floor; sending six
 * of those is six messages and no way to compare them.
 *
 * This is the only screen in the CRM a customer ever sees, and for a while it
 * looked like an internal report that had escaped: no name on it, no way to
 * reply, and the label the rep typed when making the link shown to nobody. So
 * it carries the agency's own name, number and colour now — all admin settings
 * from Admin → Settings, the same details on their website — and every card
 * ends with a way to ask about that specific unit rather than a dead end.
 *
 * What a visitor may read of the *records* is not decided here. Every unit came
 * through `loadSharedRecord` on the server, which applies the admin's own "what
 * a buyer sees" field list, so switching a field off in Admin → Data Sharing
 * switches it off on this page too without this file knowing which fields those
 * are. The same reason the title and the price arrive resolved rather than
 * looked up by name: the two names this page would have guessed at are both
 * fields production has deleted.
 *
 * Every failure — revoked, expired, mistyped, a unit deleted since — lands on
 * one message, because distinguishing them tells somebody probing for links
 * that they found a real one.
 */
import { type JSX, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronLeft, ChevronRight, Mail, MessageCircle, Phone, X } from 'lucide-react';
import { formatIndianPrice } from '@ipropy/shared';
import { api, type SharedMatches } from '../lib/api';
import { Skeleton } from '../components/ui';
import { cn } from '../lib/utils';

type Item = SharedMatches['items'][number];

/**
 * A heading for a record whose name is not being shared.
 *
 * The server resolves the title from the module's own `labelFields` and
 * honestly answers null when those are withheld — which is the normal case for
 * contacts, where the name starts off. So the fallback is built from what the
 * reader can actually see, and only falls back to a bare noun when even that is
 * empty. "Property" on a page of contacts was the alternative, and a page of
 * cards all reading the same wrong word is worse than a plain number.
 */
function title(item: Item, module: string, index: number): string {
  if (item.title) return item.title;
  /*
    `bedrooms` is a dropdown whose options are already written "3 BHK", not the
    number 3 — the whole point of [[BHK is a label]]. Appending " BHK" to it
    produced headings reading "1 BHK BHK" on the one page a customer sees.
  */
  const beds = str(item.property.bedrooms);
  const parts = [
    beds ? (/bhk/i.test(beds) ? beds : `${beds} BHK`) : null,
    str(item.property.property_type),
    str(item.property.category),
    str(item.property.locality),
  ].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return module === 'leads' ? `Requirement ${index + 1}` : `Property ${index + 1}`;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Digits only, for a `tel:` or a `wa.me` — both refuse spaces and brackets. */
function dialable(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 8) return null;
  // A ten-digit Indian number written without its country code still has to
  // reach WhatsApp, which will not guess one.
  return digits.length === 10 ? `91${digits}` : digits;
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
  const brand = data.brand;
  const isLeads = data.module === 'leads';
  const noun = data.items.length === 1
    ? (isLeads ? 'requirement' : 'property')
    : (isLeads ? 'requirements' : 'properties');

  const waNumber = dialable(brand.phone);

  /*
    The agency's colour, applied as a variable rather than to each element.

    Only a value matching `#rrggbb` reaches here — the server drops anything
    else — so this cannot become a way to write arbitrary CSS into a public
    page through a settings box.
  */
  const themed = brand.primaryColor
    ? ({ '--share-accent': brand.primaryColor } as React.CSSProperties)
    : undefined;
  const accent = brand.primaryColor ? 'var(--share-accent)' : undefined;

  return (
    <div className="min-h-screen bg-slate-50 pb-16 dark:bg-slate-950" style={themed}>
      {/*
        Who this is from, before what it is about.

        A customer opening a link on a phone sees the top two inches and decides
        whether it is real. That was the agency's name nowhere and a bare count
        of properties — which is how a genuine message reads as a forward from a
        stranger.
      */}
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div
          className="h-1 w-full"
          style={{ backgroundColor: accent ?? '#4f46e5' }}
        />
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
          {brand.logoUrl
            ? <img src={brand.logoUrl} alt="" className="h-8 w-auto max-w-[9rem] object-contain" />
            : (
              <span
                className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-white"
                style={{ backgroundColor: accent ?? '#4f46e5' }}
              >
                {brand.orgName.trim().charAt(0).toUpperCase()}
              </span>
            )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">{brand.orgName}</p>
            {brand.tagline && <p className="truncate text-xs text-muted">{brand.tagline}</p>}
          </div>
          {/* Reachable from the first screen, not only the last. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {brand.phone && (
              <a
                href={`tel:${brand.phone.replace(/\s+/g, '')}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <Phone className="h-3.5 w-3.5" /> Call
              </a>
            )}
            {waNumber && (
              <a
                href={`https://wa.me/${waNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white"
                style={{ backgroundColor: '#25D366' }}
              >
                <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
              </a>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 pt-5 sm:px-6">
        {/* The rep's own words for this set, which until now only the CRM saw. */}
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {data.label?.trim() || `${data.items.length} ${noun} for you`}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {data.label?.trim() ? `${data.items.length} ${noun} · ` : ''}
          Shared on {new Date(data.sharedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        {data.items.map((item, itemIndex) => {
          const heading = title(item, data.module, itemIndex);
          const facts = item.fields
            .map((f) => ({ ...f, value: str(item.property[f.name]) }))
            .filter((f): f is typeof f & { value: string } => Boolean(f.value));
          const askUrl = waNumber
            ? `https://wa.me/${waNumber}?text=${encodeURIComponent(`Hi, I am interested in ${heading}.`)}`
            : null;

          return (
            <article
              key={item.id}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              {item.photos.length > 0 && (
                <div className="relative">
                  <div className="flex snap-x snap-mandatory gap-1 overflow-x-auto">
                    {item.photos.map((photo, photoIndex) => (
                      <button
                        key={photo.id}
                        onClick={() => setLightbox({ item: itemIndex, photo: photoIndex })}
                        className="shrink-0 snap-start"
                        aria-label={`Photo ${photoIndex + 1} of ${heading}`}
                      >
                        <img
                          src={`${photo.url}?size=medium`}
                          alt=""
                          loading="lazy"
                          className="h-44 w-60 object-cover sm:h-52 sm:w-72"
                        />
                      </button>
                    ))}
                  </div>
                  {item.photos.length > 1 && (
                    // Otherwise a phone shows one photo and nothing says the
                    // strip scrolls, so five of the six get no views at all.
                    <span className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-2xs font-medium text-white">
                      {item.photos.length} photos · swipe
                    </span>
                  )}
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
                  <h2 className="text-base font-semibold sm:text-lg">{heading}</h2>
                  {/*
                    A unit with no price reads as "on request" rather than ₹0 —
                    an unpriced unit is the normal state of a floor somebody
                    photographed this morning, not a free one.

                    A *requirement* with no budget says nothing at all. "Price
                    on request" against somebody's stated need is the wrong
                    sentence: there is no price, there is a budget, and an empty
                    one is not something the reader can ask about.
                  */}
                  {item.priceShared && item.price ? (
                    <span
                      className="text-base font-semibold sm:text-lg"
                      style={{ color: accent ?? undefined }}
                    >
                      {formatIndianPrice(item.price)}
                    </span>
                  ) : isLeads ? null : (
                    <span className="text-sm font-medium text-muted">Price on request</span>
                  )}
                </div>

                {facts.length > 0 && (
                  <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    {facts.map((field) => (
                      <div key={field.name} className="min-w-0">
                        <dt className="text-2xs uppercase tracking-wide text-muted">{field.label}</dt>
                        <dd className="truncate text-sm font-medium">{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {/*
                  A way to reply, on the unit it is about.

                  The old page ended each card with nothing, so a buyer who
                  liked the third of six had to go back to the message that
                  carried the link and describe it in their own words. The
                  message arrives naming it.
                */}
                {askUrl && (
                  <a
                    href={askUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      'mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                      'text-sm font-semibold text-white sm:w-auto',
                    )}
                    style={{ backgroundColor: accent ?? '#4f46e5' }}
                  >
                    <MessageCircle className="h-4 w-4" />
                    Ask about this one
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <footer className="mx-auto max-w-3xl px-4 pb-6 text-center sm:px-6">
        <p className="text-sm font-medium">{brand.orgName}</p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted">
          {brand.phone && <a className="hover:underline" href={`tel:${brand.phone.replace(/\s+/g, '')}`}>{brand.phone}</a>}
          {brand.email && (
            <a className="inline-flex items-center gap-1 hover:underline" href={`mailto:${brand.email}`}>
              <Mail className="h-3 w-3" />{brand.email}
            </a>
          )}
        </div>
        <p className="mt-3 text-2xs text-muted">
          This page was prepared for you and shows only these {data.items.length} {noun}.
        </p>
      </footer>

      {open && lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`${title(open, data.module, lightbox.item)}, photo ${lightbox.photo + 1} of ${open.photos.length}`}
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
