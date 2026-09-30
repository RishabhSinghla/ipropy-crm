/**
 * The record's fields, in the right-hand pane under the call deck.
 *
 * **30 September 2026, the owner's prototype:** *"the overview details form
 * move to in replacement of Note/Comment pane below call deck"*. One line per
 * field — the name on the left, the value in a box on the right, typed into
 * where it stands — so a whole record fits the height of the pane beside the
 * call instead of needing a tab of its own.
 *
 * The three facts a call changes sit first, pinned: **who owns it, the key
 * facts the Layout Designer puts in the header (the chase date and the stage
 * unless an admin chose otherwise), and how the last call went**. Then the
 * Layout Designer's own sections, in its order. No screen names a field: all
 * of it is `useRecordPanes`, the same answer the rest of the CRM reads.
 */
import { type JSX, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { picklistOptionForValue, type FieldMeta, type RecordEnvelope } from '@ipropy/shared';
import { LayoutList } from 'lucide-react';
import { EditableField, isInlineEditable } from './EditableField';
import { FieldValue } from './FieldRenderer';
import { FollowUpChipCell, HeaderChipValue } from './RecordBlocks';
import { HeaderPills } from './HeaderPills';
import { WhatsAppIconButton } from './WhatsAppButton';
import { invalidateRecordQueries } from '../lib/invalidate';
import { badgeVars } from '../lib/color';
import { cn, restrictionForField } from '../lib/utils';
import type { DescribedModule, FieldBlockSpec } from '../lib/recordPanes';

export function RecordInspector({ module, row, canEdit, blocks, pinned, assignedField, assignedName, statusField, followUpField, phoneField }: {
  module: DescribedModule;
  row: RecordEnvelope;
  canEdit: boolean;
  blocks: FieldBlockSpec[];
  /** The header's key facts, in the Layout Designer's order. */
  pinned: FieldMeta[];
  assignedField?: FieldMeta;
  /** The owner's name, which the record's own display does not always carry. */
  assignedName?: string;
  statusField?: FieldMeta;
  followUpField?: FieldMeta;
  /** The number moved off the header, so it is still editable somewhere. */
  phoneField?: FieldMeta;
}): JSX.Element {
  const top = [
    ...(assignedField ? [assignedField] : []),
    ...pinned.filter((field) => field.name !== assignedField?.name),
  ];
  const shownAbove = new Set(top.map((field) => field.name));
  const inBlocks = new Set(blocks.flatMap((block) => block.fields.map((field) => field.name)));
  // The number is not in the header any more, so it must be here if no section has it.
  const extra = phoneField && !inBlocks.has(phoneField.name) && !shownAbove.has(phoneField.name) ? [phoneField] : [];
  const sections = blocks
    .map((block) => ({ ...block, fields: block.fields.filter((field) => !shownAbove.has(field.name)) }))
    .filter((block, index) => index === 0 || block.fields.length > 0);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3.5" data-testid="record-inspector">
      {sections.map((block, index) => (
        <section key={block.key}>
          <h3 className="mb-2 flex items-center gap-1.5 border-b border-[var(--border)] pb-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
            <LayoutList className="h-3.5 w-3.5 text-brand-600" />
            {block.label}
          </h3>
          <div className="space-y-1.5">
            {index === 0 && (
              <>
                {top.map((field) => (
                  <Row key={field.name} label={field.label} mandatory={field.isMandatory}>
                    <PinnedValue
                      module={module}
                      row={field.name === assignedField?.name && assignedName ? { ...row, display: { ...row.display, [field.name]: assignedName } } : row}
                      field={field}
                      canEdit={canEdit}
                      statusField={statusField}
                      followUpField={followUpField}
                    />
                  </Row>
                ))}
                {/* Not a field: an outcome lives on the call, so its label is the
                    owner's own word for the toolbar button that filters on it. */}
                <Row label="Call Log">
                  <HeaderPills module={module} row={row} canEdit={canEdit} size="hero" />
                </Row>
                {extra.map((field) => (
                  <Row key={field.name} label={field.label} mandatory={field.isMandatory} after={<WhatsAppBeside row={row} field={field} />}>
                    <PlainValue module={module} row={row} field={field} canEdit={canEdit} />
                  </Row>
                ))}
              </>
            )}
            {block.fields.map((field) => (
              <Row key={field.name} label={field.label} mandatory={field.isMandatory} after={<WhatsAppBeside row={row} field={field} />}>
                <PlainValue module={module} row={row} field={field} canEdit={canEdit} />
              </Row>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Row({ label, mandatory, after, children }: { label: string; mandatory?: boolean; after?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 truncate text-[10.5px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400" title={label}>
        {label}{mandatory && <span className="ml-0.5 text-negative">*</span>}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {after}
    </div>
  );
}

/**
 * The WhatsApp icon beside a phone number — the way into Chats (or the
 * composer, once a business number is connected), which stays inside the CRM.
 *
 * Outside the value's box, not in it: inside, a click meant for the icon and a
 * click meant to edit the number were one target, and on 27 September that
 * made a number impossible to change. The header used to carry this icon with
 * the number; the number lives here since 30 September, so the icon does too.
 */
function WhatsAppBeside({ row, field }: { row: RecordEnvelope; field: FieldMeta }): JSX.Element | null {
  if (field.uitype !== 'phone') return null;
  // The display value carries the country code, as the header's did.
  const number = row.display?.[field.name] ?? row.values[field.name];
  if (typeof number !== 'string' || !number) return null;
  return <WhatsAppIconButton to={number} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-slate-800" />;
}

/**
 * A value in its box, and the whole box is the target.
 *
 * `EditableField` takes the click on its own control, which on an empty field
 * is a dash in the middle of a wide box — so a click anywhere else in the box
 * is forwarded to that control. Exactly one thing opens an editor.
 */
function PlainValue({ module, row, field, canEdit }: { module: DescribedModule; row: RecordEnvelope; field: FieldMeta; canEdit: boolean }): JSX.Element {
  const queryClient = useQueryClient();
  const editable = canEdit && isInlineEditable(field);
  return (
    <FieldBox editable={editable} className="px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-100">
      {editable
        ? <EditableField
            module={module.name}
            recordId={row.id}
            field={field}
            value={row.values[field.name]}
            display={row.display?.[field.name]}
            siblings={row.values}
            restrictTo={restrictionForField(module.picklistDependencies, row.values, field.name)}
            onSaved={() => invalidateRecordQueries(queryClient, module.name, row.id)}
            compact
            plain
          />
        : <FieldValue field={field} value={row.values[field.name]} display={row.display?.[field.name]} compact plain />}
    </FieldBox>
  );
}

/**
 * The box a value sits in, and the whole box is the click target: a click on
 * its empty space is forwarded to the one control inside that opens an editor.
 */
function FieldBox({ editable, className, children }: { editable: boolean; className?: string; children: ReactNode }): JSX.Element {
  return (
    <div
      data-field-box
      className={cn(
        'min-h-[1.75rem] rounded-md border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800',
        editable && 'cursor-pointer hover:border-brand-300',
        className,
      )}
      onClick={(event) => {
        // A click on a control inside is that control's own; anything else in
        // the box (its padding, or a coloured chip around the value) opens it.
        if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
        event.currentTarget.querySelector<HTMLButtonElement>('button')?.click();
      }}
    >
      {children}
    </div>
  );
}

/** The chase date keeps the queue's own chip, and the stage the admin's colour. */
function PinnedValue({ module, row, field, canEdit, statusField, followUpField }: {
  module: DescribedModule; row: RecordEnvelope; field: FieldMeta; canEdit: boolean;
  statusField?: FieldMeta; followUpField?: FieldMeta;
}): JSX.Element {
  const queryClient = useQueryClient();
  if (field.name === followUpField?.name) {
    return (
      <FieldBox editable={canEdit} className="flex items-center px-2 py-0.5">
        <FollowUpChipCell module={module} row={row} field={field} canEdit={canEdit} size="hero" />
      </FieldBox>
    );
  }
  if (field.name === statusField?.name) {
    const colour = picklistOptionForValue(field.options, row.values[field.name])?.color;
    return (
      <FieldBox editable={canEdit && isInlineEditable(field)} className="flex items-center px-2 py-0.5">
        <span
          className={cn('inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-[11px] font-semibold', colour ? 'badge-tinted' : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200')}
          style={colour ? badgeVars(colour) : undefined}
        >
          <HeaderChipValue module={module} row={row} field={field} canEdit={canEdit} asWords onSaved={() => invalidateRecordQueries(queryClient, module.name, row.id)} />
        </span>
      </FieldBox>
    );
  }
  return <PlainValue module={module} row={row} field={field} canEdit={canEdit} />;
}
