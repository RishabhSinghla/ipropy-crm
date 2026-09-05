import { type JSX, useState } from 'react';
/**
 * What the buyer sees.
 *
 * The only screen in this product with no signed-in user behind it, and the
 * design follows from that: someone who has never heard of iPropy has just
 * tapped a link in WhatsApp on a mid-range Android, probably on mobile data,
 * standing somewhere. They will decide whether to keep scrolling in about two
 * seconds.
 *
 * So: photos first and large, price and configuration immediately under them,
 * everything else below the fold, and one obvious way to reply. No navigation,
 * no login prompt, nothing to dismiss.
 *
 * It deliberately shows no availability status and no internal note. The page
 * exists because a dealer chose to send this property to this person — the
 * status of the record is the dealer's business, and the label on the link is
 * their private note about the recipient.
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronLeft, ChevronRight, ImageOff, MapPin, X } from 'lucide-react';
import { formatIndianPrice } from '@ipropy/shared';
import { api } from '../lib/api';
import { Skeleton } from '../components/ui';
import { cn } from '../lib/utils';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const parsed = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function sharedValue(
  field: { name: string; uitype: string },
  value: unknown,
  property: Record<string, unknown>,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) return value.filter(Boolean).join(', ') || null;
  if (field.uitype === 'boolean') return value === true || value === 'true' ? 'Yes' : 'No';
  if (field.uitype === 'currency' || (field.uitype === 'formula' && /(price|rent|charge|deposit)/i.test(field.name))) {
    const amount = num(value);
    return amount === null ? null : formatIndianPrice(amount);
  }
  if (field.uitype === 'area') {
    const area = num(value);
    if (area === null) return null;
    const unit = str(property.area_unit) ?? 'sq.ft.';
    return `${area.toLocaleString('en-IN')} ${unit}`;
  }
  if (field.uitype === 'percent') return `${value}%`;
  if (field.uitype === 'date' || field.uitype === 'datetime') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-IN');
  }
  if (typeof value === 'object') return null;
  return String(value);
}

export default function SharedPropertyPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [lightbox, setLightbox] = useState<number | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['shared', token],
    queryFn: () => api.sharedProperty(token!),
    enabled: Boolean(token),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <Skeleton className="aspect-[4/3] w-full" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  // One message for every failure — revoked, expired, mistyped, deleted. The
  // server answers them identically on purpose (telling someone probing for
  // links that they found a real one is the thing to avoid), and the page must
  // not undo that by guessing.
  if (isError || !data) {
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

  const p = data.property;
  const title = (str(p.project_name) ?? str(p.name)
    ?? [str(p.configuration), str(p.property_type)].filter(Boolean).join(' ')) || 'Property';
  const unitName = str(p.name);
  const price = num(p.total_price);
  const place = [str(p.locality), str(p.city)].filter(Boolean).join(', ');

  const heroFields = new Set(['name', 'project_name', 'total_price', 'locality', 'city', 'description', 'amenities', 'area_unit']);
  const facts = data.fields.flatMap((field) => {
    if (heroFields.has(field.name)) return [];
    const value = sharedValue(field, p[field.name], p);
    return value ? [{ label: field.label, value }] : [];
  });

  const amenities = Array.isArray(p.amenities)
    ? (p.amenities as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];

  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-2xl pb-16">
        <Gallery photos={data.photos} onOpen={setLightbox} />

        <div className="space-y-6 p-4">
          <header className="space-y-2">
            <h1 className="text-2xl font-semibold leading-tight">{title}</h1>
            {unitName && unitName !== title && <p className="text-muted">{unitName}</p>}
            {price !== null && (
              <p className="text-2xl font-semibold text-fg">{formatIndianPrice(price)}</p>
            )}
            {place && (
              <p className="flex items-center gap-1.5 text-sm text-muted">
                <MapPin className="h-4 w-4 shrink-0" /> {place}
              </p>
            )}
          </header>

          {facts.length > 0 && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
              {facts.map((f) => (
                <div key={f.label}>
                  <dt className="text-xs text-muted">{f.label}</dt>
                  <dd className="text-sm font-medium">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {str(p.description) && (
            <section className="space-y-1">
              <h2 className="text-sm font-semibold">About this property</h2>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{str(p.description)}</p>
            </section>
          )}

          {amenities.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Amenities</h2>
              <ul className="flex flex-wrap gap-1.5">
                {amenities.map((a) => (
                  <li key={a} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-muted dark:border-slate-700">
                    {a}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="pt-2 text-center text-xs text-muted">
            Shared with you privately. Please contact the person who sent this link for a viewing.
          </p>
        </div>
      </div>

      {lightbox !== null && data.photos[lightbox] && (
        <Lightbox
          photos={data.photos}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
        />
      )}
    </div>
  );
}

/**
 * Photos first and large.
 *
 * The lead image is the decision — a buyer scrolling WhatsApp gives this about
 * two seconds — so it gets the full width and the rest becomes a strip beneath
 * it rather than a grid competing with it.
 */
function Gallery({
  photos, onOpen,
}: { photos: { id: string; url: string }[]; onOpen: (index: number) => void }): JSX.Element {
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  if (!photos.length) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center bg-subtle text-muted">
        <ImageOff className="h-8 w-8" />
      </div>
    );
  }

  const [lead, ...rest] = photos;

  return (
    <div>
      <button
        type="button"
        className="block w-full"
        onClick={() => onOpen(0)}
        aria-label="Open photo 1 full screen"
      >
        {broken[lead!.id] ? (
          <div className="flex aspect-[4/3] items-center justify-center bg-subtle text-muted">
            <ImageOff className="h-8 w-8" />
          </div>
        ) : (
          <img
            src={`${lead!.url}?size=large`}
            alt=""
            className="aspect-[4/3] w-full object-cover"
            onError={() => setBroken((b) => ({ ...b, [lead!.id]: true }))}
          />
        )}
      </button>

      {rest.length > 0 && (
        <div className="flex gap-1 overflow-x-auto p-1">
          {rest.map((photo, i) => (
            <button
              key={photo.id}
              type="button"
              className="h-20 w-20 shrink-0 overflow-hidden rounded-md bg-subtle"
              onClick={() => onOpen(i + 1)}
              aria-label={`Open photo ${i + 2} full screen`}
            >
              {broken[photo.id] ? (
                <div className="flex h-full items-center justify-center text-muted"><ImageOff className="h-4 w-4" /></div>
              ) : (
                <img
                  src={`${photo.url}?size=thumb`}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                  onError={() => setBroken((b) => ({ ...b, [photo.id]: true }))}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Lightbox({
  photos, index, onClose, onIndex,
}: {
  photos: { id: string; url: string }[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}): JSX.Element {
  const go = (delta: number): void => {
    onIndex((index + delta + photos.length) % photos.length);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95">
      <button
        type="button"
        className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white"
        onClick={onClose}
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>

      <img src={`${photos[index]!.url}?size=large`} alt="" className="max-h-full max-w-full object-contain" />

      {photos.length > 1 && (
        <>
          <button
            type="button"
            className={cn('absolute left-2 rounded-full bg-white/10 p-3 text-white')}
            onClick={() => go(-1)}
            aria-label="Previous photo"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            className={cn('absolute right-2 rounded-full bg-white/10 p-3 text-white')}
            onClick={() => go(1)}
            aria-label="Next photo"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <p className="absolute bottom-4 text-sm text-white/70">{index + 1} / {photos.length}</p>
        </>
      )}
    </div>
  );
}
