/**
 * Meta-tools that must survive tool-surface narrowing.
 *
 * Both shelves are host-side selectors. Hiding their controls behind the
 * selection they govern creates an unrecoverable state, so phase allowlists
 * and harness intersections always preserve these names when they exist.
 */
export const UNIFIED_CAPABILITY_SHELF_CONTROL_NAMES = [
  'capability_search',
  'capability_load',
  'capability_list_active',
] as const;

export const TRANSIENT_TOOL_SHELF_CONTROL_NAMES = [
  'search_tools',
  'load_tool',
  'release_tools',
  'list_active_tools',
] as const;

export const TRANSIENT_SKILL_SHELF_CONTROL_NAMES = [
  'skill_search',
  'skill_load',
  'skill_list_active',
  'skill_swap',
  'skill_release',
] as const;

export const TRANSIENT_SHELF_CONTROL_NAMES = [
  ...UNIFIED_CAPABILITY_SHELF_CONTROL_NAMES,
  ...TRANSIENT_TOOL_SHELF_CONTROL_NAMES,
  ...TRANSIENT_SKILL_SHELF_CONTROL_NAMES,
] as const;

export const TRANSIENT_SHELF_CONTROL_SET = new Set<string>(TRANSIENT_SHELF_CONTROL_NAMES);

