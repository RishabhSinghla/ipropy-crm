import type { FieldMeta } from '@ipropy/shared';

/**
 * The property category field (Builder Floor, Flat, House, Plot…) a module offers
 * in Search options, or undefined where it has none.
 *
 * Found by its column name or the dropdown it draws on, never by a label, so an
 * admin renaming it to "Property type" does not take the filter away.
 */
export function categorySearchField(fields: FieldMeta[]): FieldMeta | undefined {
  return fields.find((field) => field.columnName === 'category' || field.name === 'category' || field.config.picklist === 'category');
}
