import { useMemo } from 'react';
import type { FieldMeta, ModuleMeta } from '@ipropy/shared';
import { assignmentField, pipelineFieldOf, subtitleFieldsOf } from './fields';
import { heroFieldNames, splitTabsFor, type SplitTab } from './splitViewLayout';

/**
 * Which fields a record's panes show, decided once for every screen that
 * shows a record.
 *
 * **This lived inside `IpropyWorkspace` until 20 September 2026**, when the
 * owner asked for the whole record beside a WhatsApp chat: *"I do not want to
 * switch screen during whatsapp chat and then and there I want all info of
 * that record everything in the right pane"*. Two screens now need the same
 * answer, and a second copy of this reasoning is the mistake this repo keeps
 * finding months later — one of them would learn about a new Admin → Split
 * View setting and the other would not, and the same record would read
 * differently depending on which screen you arrived from.
 *
 * Everything here is **metadata, never a field name written into code**: the
 * Layout Designer's arrangement first, then the module's own flags. A screen
 * that named `budget` or `unit_number` itself would freeze those into a
 * deploy, which is the one rule this CRM is built around.
 *
 * **Admin → Split View was removed on 27 September 2026, on the owner's
 * instruction** — *"You can completely remove master of Split view, bcoz we
 * need to design i. future by my self of all key fields"*. It was a third
 * source that outranked the other two, and with the new three-pane record it
 * had nothing left to arrange: the middle pane shows the Layout Designer's
 * own blocks. The `ui.split_view` row is simply no longer read; no migration
 * drops it, so an arrangement made before today is still in the database if
 * it is ever wanted back.
 */
export type DescribedModule = ModuleMeta & {
  permissions: { view: boolean; create: boolean; edit: boolean; delete: boolean };
  picklistDependencies: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[];
  layouts?: { id: string; name: string; type: string; is_default: boolean; config: unknown }[];
};

/** What the Layout Designer arranged, read the same way the record page reads it. */
export interface DetailLayout {
  blocks?: { key: string; label: string; columns: number; collapsed?: boolean; fields: string[] }[];
  headerFields?: string[];
  headerFieldsCustomized?: boolean;
  queueFields?: string[];
  /** The key facts in the split view's header; see `lib/splitViewLayout.ts`. */
  heroFields?: string[];
  /** The split view's tabs, in order; the first is the one a record opens on. */
  splitTabs?: { key: string; label?: string }[];
}

export interface FieldBlockSpec {
  key: string;
  label: string;
  columns: number;
  fields: FieldMeta[];
}

/**
 * Header fields the owner asked to read in Basic Information instead.
 *
 * 19 September 2026: "Lost Reason, Contact Type, Unit Number be removed from
 * the header of the split pane on the right side and be moved in the basic
 * information below where they can be inline editable."
 *
 * **Empty since 27 September 2026**, when he asked for Lost Reason back — as
 * one of the five coloured chips under the name. The set stays because the
 * mechanism it feeds is still right: a field taken off the header has to land
 * in a block or it is simply lost.
 */
export const DEMOTED_FROM_HEADER = new Set<string>([]);

/**
 * The chips under the record's name, in the owner's own order.
 *
 * **27 September 2026:** *"Blow Name Stripe We Need editable Beautiful solid
 * multi colour rounded chips of Lead/Inventory Status, Lost Reason,
 * Lead/Inventory Sourse, Next Followup, Contact Type."*
 *
 * Found by the **picklist each field is bound to**, not by the field's own
 * name: a name is something an admin renames on a Tuesday, and production's
 * stage field has been called `status` with picklist `lead_status` since one
 * such rename. A module that has no field bound to one of these — Inventories
 * has no contact type and no source — simply shows one chip fewer, rather than
 * an empty one.
 */
const CHIP_PICKLISTS: ((picklist: string) => boolean)[] = [
  (picklist) => picklist === 'lost_reason',
  (picklist) => picklist.endsWith('_source'),
  (picklist) => picklist === 'contact_type',
];

export interface RecordPanes {
  /** The strip beside the record's name. */
  headerFields: FieldMeta[];
  /** Optional admin-arranged facts in the queue card's middle line. */
  queueFields?: FieldMeta[];
  /** The cards below it, in the Layout Designer's grouping. */
  blocks: FieldBlockSpec[];
  /** The line under a name in a queue — `Buyer — 304`. */
  subtitleFields: FieldMeta[];
  assignedField?: FieldMeta;
  statusField?: FieldMeta;
  followUpField?: FieldMeta;
  phoneField?: FieldMeta;
  /** The first email on the record, so a header can offer to write to it. */
  emailField?: FieldMeta;
  /** The key facts in the split view's header, in the Layout Designer's order. */
  heroFields: FieldMeta[];
  /** The split view's tabs; the first is the one a record opens on. */
  tabs: SplitTab[];
}

export function useRecordPanes(module: DescribedModule): RecordPanes {
  const layout = useMemo<DetailLayout>(
    () => (module.layouts?.find((l) => l.type === 'detail' && l.is_default)?.config ?? {}) as DetailLayout,
    [module.layouts],
  );
  const fieldMap = useMemo(() => new Map(module.fields.map((field) => [field.name, field])), [module.fields]);
  const queueFields = useMemo(() => layout.queueFields?.map((name) => fieldMap.get(name))
    .filter((field): field is FieldMeta => Boolean(field?.isActive && field.displayType !== 'hidden')),
  [layout.queueFields, fieldMap]);

  const assignedField = useMemo(() => assignmentField(module.fields), [module.fields]);

  const subtitleFields = useMemo(() => subtitleFieldsOf(module.fields), [module.fields]);

  /*
    The module's own pipeline field — Lead Status on a contact, Property Status
    on a unit — through the one helper that knows a rename moves a field's name
    and leaves its column alone. There is deliberately no fallback guess: it
    used to take the first field whose name contained "status", and both
    modules carry others (`kyc_status`, `possession_status`) that are empty on
    nearly every record, so a guess reads as the feature being broken.
  */
  const statusField = useMemo(() => pipelineFieldOf(module), [module]);
  const followUpField = useMemo(
    () => module.fields.find((f) => f.columnName === 'next_followup_at')
      ?? module.fields.find((f) => /next.*follow.*up/i.test(f.name)),
    [module.fields],
  );
  const phoneField = useMemo(() => module.fields.find((f) => f.uitype === 'phone'), [module.fields]);
  /*
    **28 September 2026, the owner:** *"show email Icon in Icon bar of middle
    pane, If Record have a Email Id, so that we can send mail directly from
    icon."* Found by uitype like the phone beside it, never by the name
    `email` — a module may call it Work Email, and an admin may rename it on a
    Tuesday. A module with no email field simply gets no icon.
  */
  const emailField = useMemo(() => module.fields.find((f) => f.uitype === 'email'), [module.fields]);

  /*
    The five the owner named, found through metadata and in his order: the
    stage, why it was lost, where it came from, when to chase them, and what
    kind of contact this is.
  */
  const chipFields = useMemo(() => {
    const byPicklist = CHIP_PICKLISTS
      .map((matches) => module.fields.find((field) => {
        const picklist = field.config.picklist;
        return typeof picklist === 'string' && matches(picklist);
      }))
      .filter((field): field is FieldMeta => Boolean(field));
    const [lostReason, source, contactType] = [byPicklist[0], byPicklist[1], byPicklist[2]];
    return [statusField, lostReason, source, followUpField, contactType]
      .filter((field): field is FieldMeta => Boolean(field));
  }, [module.fields, statusField, followUpField]);

  const headerFields = useMemo(() => {
    const names: string[] = [...(layout.headerFields ?? [])];
    if (!layout.headerFieldsCustomized) {
      for (const field of [phoneField, ...chipFields]) {
        if (field && !names.includes(field.name)) names.push(field.name);
      }
    }
    const identity = new Set(module.labelFields);
    const named = new Set(chipFields.map((field) => field.name));
    return names
      .filter((name) => name !== assignedField?.name)
      // The record's own name is the heading above this strip; repeating it
      // two inches below said the same thing twice.
      .filter((name) => !identity.has(name))
      .filter((name) => !DEMOTED_FROM_HEADER.has(name))
      /*
        A field that already reads on every queue row is not repeated here —
        **unless the owner named it as a chip**. Contact Type is both, and on
        27 September 2026 he asked for it in the header by name.
      */
      .filter((name) => layout.headerFieldsCustomized || named.has(name) || !subtitleFields.some((field) => field.name === name))
      .map((name) => fieldMap.get(name))
      .filter((field): field is FieldMeta => Boolean(field && field.isActive && field.displayType !== 'hidden'));
  }, [layout.headerFields, layout.headerFieldsCustomized, fieldMap, module.labelFields, assignedField, phoneField, chipFields, subtitleFields]);

  const blocks = useMemo<FieldBlockSpec[]>(() => {
    const identity = new Set(module.labelFields);
    const usable = (field: FieldMeta | undefined): field is FieldMeta =>
      Boolean(field && field.isActive && field.displayType !== 'hidden' && field.uitype !== 'autonumber');

    const arranged = (layout.blocks ?? [])
      .map((block) => ({
        key: block.key,
        label: block.label,
        columns: block.columns,
        fields: block.fields.map((name) => fieldMap.get(name)).filter(usable),
      }))
      .filter((block) => block.fields.length);

    if (arranged.length) {
      /*
        A field taken off the header has to land somewhere, or the owner has
        simply lost it — and a value you can no longer see is one you can no
        longer edit. They go into the first block, where `FieldBlock` renders
        them inline-editable like everything else.
      */
      const placed = new Set(arranged.flatMap((block) => block.fields.map((field) => field.name)));
      const homeless = [...DEMOTED_FROM_HEADER, ...subtitleFields.map((field) => field.name)]
        .filter((name) => !placed.has(name))
        .map((name) => fieldMap.get(name))
        .filter(usable);
      if (homeless.length) {
        arranged[0] = { ...arranged[0]!, fields: [...arranged[0]!.fields, ...homeless] };
      }
      return arranged;
    }

    return [{
      key: 'all',
      label: 'Basic Information',
      columns: 2,
      fields: module.fields
        .filter(usable)
        .filter((field) => !identity.has(field.name))
        .sort((a, b) => a.sequence - b.sequence),
    }];
  }, [layout.blocks, fieldMap, module.fields, module.labelFields, subtitleFields]);

  const heroFields = useMemo(
    () => heroFieldNames(layout.heroFields, followUpField?.name, statusField?.name)
      .map((name) => fieldMap.get(name))
      .filter((field): field is FieldMeta => Boolean(field?.isActive && field.displayType !== 'hidden')),
    [layout.heroFields, followUpField, statusField, fieldMap],
  );
  const tabs = useMemo(() => splitTabsFor(module.name, layout.splitTabs), [module.name, layout.splitTabs]);

  return {
    headerFields, queueFields, blocks, subtitleFields,
    assignedField, statusField, followUpField, phoneField, emailField,
    heroFields, tabs,
  };
}
