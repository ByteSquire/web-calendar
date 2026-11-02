// Which sections of the sidebar are folded away (FR-21). A preference of this browser, kept in
// localStorage: a list of the section titles that are closed, so a new section starts open. Pure
// functions on a store, so they run in plain Vitest; SidebarSection.vue uses them.
import type { KeyValueStore } from '~/utils/resources/updates'

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
