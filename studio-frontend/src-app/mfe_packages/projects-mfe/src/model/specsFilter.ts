/** The values of the Specs list's *Filter specs*, in the menu's order */

// @cpt-dod:cpt-studiofrontend-dod-project-specs-filter-state:p1
export const SPECS_FILTERS = [
  'all',
  'with_findings',
  'check_needed',
  'type_not_set',
  'type_to_confirm',
  'type_confirmed',
  'not_specifications',
] as const;

export type SpecsFilter = (typeof SPECS_FILTERS)[number];

export const isSpecsFilter = (value: unknown): value is SpecsFilter =>
  SPECS_FILTERS.includes(value as SpecsFilter);
