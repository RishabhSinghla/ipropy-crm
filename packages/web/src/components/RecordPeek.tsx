/**
 * What a long press on a record shows: the whole card, without opening it.
 *
 * The point is the round trip it removes. On a phone, checking one number
 * today means open the record, read it, press back, lose your place in the
 * list, scroll to find it again — and down a list of forty leads that is most
 * of what using the CRM on a phone costs.
 *
 * So this is deliberately **read-only**. A peek that let you edit would need
 * the keyboard, which covers half the screen, which defeats the purpose; the
 * record page is one tap away and does that job properly. The one exception is
 * dialling, because ringing somebody is the thing you most often wanted the
 * number *for*, and making that possible without leaving the list is the whole
 * saving repeated.
 *
 * Built on `Modal` rather than a bespoke overlay so it inherits the focus trap,
 * Escape handling, backdrop dismissal and `aria-modal` — a peek is still a
 * dialog, and the accessibility suite scans it like one.
 */
import { Phone, Star } from 'lucide-react';
import type { FieldMeta, ModuleMeta, RecordEnvelope } from '@ipropy/shared';
import { Modal } from './ui';
import { FieldValue } from './FieldRenderer';

/** The first phone-shaped value on the record, whatever the module calls it. */
function firstPhone(row: RecordEnvelope, fields: FieldMeta[]): string | null {
  for (const field of fields) {
    if (field.uitype !== 'phone') continue;
    const raw = row.values[field.name];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
}

export default function RecordPeek({
  row, module, columns, fieldMap, isNew, isStarred, onOpen, onClose,
}: {
  row: RecordEnvelope | null;
  module: ModuleMeta;
  /** The columns the list is already showing — a peek should not reveal more than the list would. */
  columns: string[];
  fieldMap: Map<string, FieldMeta>;
  isNew: boolean;
  isStarred: boolean;
  onOpen: () => void;
  onClose: () => void;
}): JSX.Element | null {
  if (!row) return null;

  // Same rule the card itself uses: fields that make up the title are already
  // the heading, and empty ones are noise.
  const titleFields = new Set(module.labelFields ?? []);
  const detail = columns.filter((col) => {
    if (titleFields.has(col)) return false;
    const field = fieldMap.get(col);
    if (!field || field.uitype === 'autonumber') return false;
    const value = row.values[col];
    return value !== null && value !== undefined && value !== ''
      && !(Array.isArray(value) && !value.length);
  });

  const phone = firstPhone(row, [...fieldMap.values()]);

  return (
    <Modal
      open
      onClose={onClose}
      title={row.label}
      size="sm"
      footer={(
        <>
          {phone && (
            <a href={`tel:${phone}`} className="btn-secondary btn-sm mr-auto">
              <Phone className="h-3.5 w-3.5" />
              Call
            </a>
          )}
          {/* No Close button here on purpose. The dialog already closes three
              ways — the header ✕, the backdrop and Escape — and a fourth with
              the same accessible name gave the dialog two controls called
              "Close", which reads as a duplicate to a screen reader. The
              footer is for the things you came here to *do*. */}
          <button type="button" onClick={onOpen} className="btn-primary btn-sm">Open</button>
        </>
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {row.recordNumber && (
          <span className="font-mono text-2xs text-muted">{row.recordNumber}</span>
        )}
        {isStarred && (
          <span className="inline-flex items-center gap-1 text-2xs text-amber-600 dark:text-amber-400">
            <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
            Favourite
          </span>
        )}
        {isNew && (
          <span className="inline-flex items-center gap-1 text-2xs text-brand-600 dark:text-brand-400">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-600 dark:bg-brand-400" />
            Needs attention
          </span>
        )}
      </div>

      {detail.length ? (
        <dl className="space-y-2">
          {detail.map((col) => {
            const field = fieldMap.get(col)!;
            return (
              <div key={col} className="flex items-start gap-3 text-sm">
                <dt className="w-32 shrink-0 truncate text-xs text-muted">{field.label}</dt>
                <dd className="min-w-0 flex-1">
                  <FieldValue
                    field={field}
                    value={row.values[col]}
                    display={row.display?.[col]}
                    compact
                  />
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-sm text-muted">Nothing else recorded yet.</p>
      )}
    </Modal>
  );
}
