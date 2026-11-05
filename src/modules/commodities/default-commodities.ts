/**
 * The list every new shop starts with. The owner can edit, deactivate or
 * delete them; bag weight is left empty so each shop sets its own.
 * Existing shops are not back-filled.
 */
export const DEFAULT_COMMODITIES = [
  { name: 'Gandum', nameUr: 'گندم', category: 'grain' }, // wheat
  { name: 'Kapas', nameUr: 'کپاس', category: 'fibre' }, // cotton
  { name: 'Chawal', nameUr: 'چاول', category: 'grain' }, // rice
  { name: 'Dhaan', nameUr: 'دھان', category: 'grain' }, // paddy
  { name: 'Makai', nameUr: 'مکئی', category: 'grain' }, // maize
  { name: 'Chana', nameUr: 'چنا', category: 'pulse' }, // gram
  { name: 'Sarson', nameUr: 'سرسوں', category: 'oilseed' }, // mustard
  { name: 'Sabzi', nameUr: 'سبزی', category: 'vegetable' }, // vegetables
] as const;

/** Rows to insert for one shop (`tenant_id` set, defaults for the rest). */
export function defaultCommodityRows(tenantId: string) {
  return DEFAULT_COMMODITIES.map((c) => ({
    tenantId,
    name: c.name,
    nameUr: c.nameUr,
    category: c.category,
    defaultUnit: 'maund',
    bagWeightKg: null,
  }));
}
