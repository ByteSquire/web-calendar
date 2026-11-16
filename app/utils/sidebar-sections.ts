// Which sections of the sidebar are folded away (FR-21). A preference of this browser, kept in
// localStorage: a list of the section titles that are closed, so a new section starts open. Pure
// functions on a store, so they run in plain Vitest; SidebarSection.vue uses them.
import { N_ } from '~/utils/i18n'
import type { KeyValueStore } from '~/utils/resources/updates'
import type { SidebarSectionId } from '../../shared/utils/sidebar-sections'

export const SIDEBAR_CLOSED_KEY = 'web-calendar:sidebar-closed'

/** The closed titles; anything unreadable or not a list of text counts as nothing closed. */
export function readClosedSections(store: KeyValueStore | null): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(SIDEBAR_CLOSED_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string'))]
  } catch {
    return []
  }
}

/** Storage can be full or blocked: not remembering only means the section opens again next time. */
export function writeClosedSections(store: KeyValueStore | null, closed: readonly string[]): void {
  try {
    store?.setItem(SIDEBAR_CLOSED_KEY, JSON.stringify(closed))
  } catch {
    // Ignored on purpose.
  }
}

/** The list with `title` closed when it was open and open when it was closed. */
export function toggleSection(closed: readonly string[], title: string): string[] {
  return closed.includes(title) ? closed.filter((item) => item !== title) : [...closed, title]
}

/**
 * The English title of each section. It is also the key of the folded state above, so it stays
 * English in the saved data in every language; the sidebar shows its translation. The order the
 * sections come in is the user's own and is kept on the server (shared/utils/sidebar-sections.ts).
 */
export const SECTION_TITLES: Record<SidebarSectionId, string> = {
  views: N_('Views'),
  calendars: N_('Calendars'),
  resources: N_('Resources'),
  categories: N_('Categories'),
  filters: N_('Filters'),
}

/** What a section's plus adds. */
export type AddNoun = 'view' | 'calendar' | 'category' | 'filter'

/** What is added by its name alone, in a field; views and filters have a dialog of their own. */
export type FieldAddNoun = 'calendar' | 'category'

/** The texts of each kind, whole, so that a translation can put the word where it belongs. */
export const ADD_TEXTS: Record<AddNoun, { add: string }> = {
  view: { add: N_('Add view') },
  calendar: { add: N_('Add calendar') },
  category: { add: N_('Add category') },
  filter: { add: N_('Add filter') },
}

/** The label of the field that takes the name. */
export const FIELD_LABELS: Record<FieldAddNoun, string> = {
  calendar: N_('New calendar name'),
  category: N_('New category name'),
}
