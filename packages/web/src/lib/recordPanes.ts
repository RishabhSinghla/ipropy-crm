import { useMemo } from 'react';
import type { FieldMeta, ModuleMeta } from '@ipropy/shared';
import { assignmentField, pipelineFieldOf, subtitleFieldsOf } from './fields';
import { useApp } from './store';

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
 * admin's Split View arrangement first, then the Layout Designer's, then the
 * module's own flags. A screen that named `budget` or `unit_number` itself
 * would freeze those into a deploy, which is the one rule this CRM is built
 * around.
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
 * By field name and not by label, because a label is something an admin
 * renames on a Tuesday and a name is the key everything else in this CRM uses.
 */
export const DEMOTED_FROM_HEADER = new Set(['lost_reason']);

export interface RecordPanes {
  /** The strip beside the record's name. */
  headerFields: FieldMeta[];
  /** The cards below it, in the Layout Designer's grouping. */
  blocks: FieldBlockSpec[];
  /** The line under a name in a queue — `Buyer — 304`. */
  subtitleFields: FieldMeta[];
  assignedField?: FieldMeta;
  statusField?: FieldMeta;
  followUpField?: FieldMeta;
  phoneField?: FieldMeta;
}

export function useRecordPanes(module: DescribedModule): RecordPanes {
  const layout = useMemo<DetailLayout>(
    () => (module.layouts?.find((l) => l.type === 'detail' && l.is_default)?.config ?? {}) as DetailLayout,
    [module.layouts],
  );
  const fieldMap = useMemo(() => new Map(module.fields.map((field) => [field.name, field])), [module.fields]);

  /*
    What Admin → Split View says this module shows, if anything.

    Three ordered lists, each of which **wins over the shipped answer only when
    it is not empty**. That is the whole safety of the setting: a module nobody
    has arranged behaves exactly as it did before the screen existed, and an
    admin who clears a list gets the fallback back rather than a blank pane.
  */
  const panes = useApp((st) => st.user?.ui?.splitView?.[module.name]) ?? null;
  const pickFields = useMemo(() => (names: string[] | undefined): FieldMeta[] => (names ?? [])
    .map((name) => fieldMap.get(name))
    .filter((field): field is FieldMeta => Boolean(field && field.isActive && field.displayType !== 'hidden')),
  [fieldMap]);

  const assignedField = useMemo(() => assignmentField(module.fields), [module.fields]);

  const subtitleFields = useMemo(() => {
    const chosen = pickFields(panes?.queue);
    return chosen.length ? chosen : subtitleFieldsOf(module.fields);
  }, [panes?.queue, pickFields, module.fields]);

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

  const headerFields = useMemo(() => {
    const chosen = pickFields(panes?.header);
    if (chosen.length) return chosen.filter((field) => field.name !== assignedField?.name);

    const names: string[] = [...(layout.headerFields ?? [])];
    for (const field of [phoneField, followUpField, statusField]) {
      if (field && !names.includes(field.name)) names.push(field.name);
    }
    return names
      .filter((name) => name !== assignedField?.name)
      .filter((name) => !DEMOTED_FROM_HEADER.has(name))
      // Contact Type and Unit Number already read on every queue row, under
      // the name. Repeating them two inches away said the same thing twice.
      .filter((name) => !subtitleFields.some((field) => field.name === name))
      .map((name) => fieldMap.get(name))
      .filter((field): field is FieldMeta => Boolean(field && field.isActive && field.displayType !== 'hidden'));
  }, [panes?.header, pickFields, layout.headerFields, fieldMap, assignedField, phoneField, followUpField, statusField, subtitleFields]);

  const blocks = useMemo<FieldBlockSpec[]>(() => {
    const identity = new Set(module.labelFields);
    const usable = (field: FieldMeta | undefined): field is FieldMeta =>
      Boolean(field && field.isActive && field.displayType !== 'hidden' && field.uitype !== 'autonumber');

    /*
      An admin's own list is one card in their order. Deliberately flat: the
      blocks are the Layout Designer's grouping, and a second screen inventing
      groups of its own would be two answers to "which section is this in".
    */
    const chosen = pickFields(panes?.form).filter(usable);
    if (chosen.length) return [{ key: 'chosen', label: 'Details', columns: 2, fields: chosen }];

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
  }, [panes?.form, pickFields, layout.blocks, fieldMap, module.fields, module.labelFields, subtitleFields]);

  return { headerFields, blocks, subtitleFields, assignedField, statusField, followUpField, phoneField };
}
