// Categories of live data (FR-2): the viewer's and the shared ones from `/api/categories`, plus
// "auto" categories for names that events carry (iCal CATEGORIES) but nobody created. Events keep
// the names (`categoryNames`); the ids are resolved here, so a category created later links up with
// events that are already on screen.
import type { CalendarEvent, Category } from '../../../shared/types/calendar'
import type { ApiCategory } from './api-types'
import { colorForName, normalizeHexColor } from './palette'

export const AUTO_CATEGORY_PREFIX = 'auto:'

export const isAutoCategory = (category: Pick<Category, 'id'>): boolean =>
  category.id.startsWith(AUTO_CATEGORY_PREFIX)

/** Names compare without regard to case or surrounding space. */
const keyOf = (name: string): string => name.trim().toLowerCase()

export function autoCategoryId(name: string): string {
  return `${AUTO_CATEGORY_PREFIX}${keyOf(name)}`
}

/** Server categories as the state holds them; the colour falls back to one derived from the name. */
export function toCategories(categories: readonly ApiCategory[]): Category[] {
  return categories.map((category) => ({
    id: String(category.id),
    name: category.name,
    color: normalizeHexColor(category.color) ?? colorForName(category.name),
    ...(category.shared ? { shared: true } : {}),
  }))
}

/**
 * The category ids for the names of an event, in the order of the names, without repeats. A name
 * that matches a real category (any letter case) maps to it; any other name maps to its auto id.
 */
export function mapCategoryIds(
  names: readonly string[] | undefined,
  categories: readonly Category[],
): string[] {
  if (!names || names.length === 0) return []
  const byName = new Map<string, string>()
  // Real categories win over auto ones with the same name; of several real ones the first wins.
  for (const wantAuto of [false, true]) {
    for (const category of categories) {
      if (isAutoCategory(category) === wantAuto && !byName.has(keyOf(category.name))) {
        byName.set(keyOf(category.name), category.id)
      }
    }
  }
  const ids: string[] = []
  for (const name of names) {
    if (keyOf(name) === '') continue
    const id = byName.get(keyOf(name)) ?? autoCategoryId(name)
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The category list after `events` were read: real categories as they are, then the auto
 * categories. Auto categories seen earlier stay (a selected one must not vanish when the viewer
 * moves to a week without it) unless a real category with that name exists by now. The same array
 * is returned when nothing changes, so a watcher on the list stays quiet.
 */
export function reconcileCategories(
  current: readonly Category[],
  events: readonly Pick<CalendarEvent, 'categoryNames'>[],
): readonly Category[] {
  const real = current.filter((category) => !isAutoCategory(category))
  const realNames = new Set(real.map((category) => keyOf(category.name)))

  const auto = new Map<string, Category>()
  for (const category of current) {
    if (isAutoCategory(category) && !realNames.has(keyOf(category.name))) {
      auto.set(category.id, category)
    }
  }
  for (const event of events) {
    for (const name of event.categoryNames ?? []) {
      const trimmed = name.trim()
      if (trimmed === '' || realNames.has(keyOf(trimmed))) continue
      const id = autoCategoryId(trimmed)
      if (!auto.has(id)) auto.set(id, { id, name: trimmed, color: colorForName(trimmed) })
    }
  }

  const next = [...real, ...auto.values()]
  const unchanged =
    next.length === current.length && next.every((category, index) => category === current[index])
  return unchanged ? current : next
}

/** `events` with `categoryIds` resolved against `categories`; untouched events are the same objects. */
export function withCategoryIds(
  events: readonly CalendarEvent[],
  categories: readonly Category[],
): CalendarEvent[] {
  return events.map((event) => {
    const ids = mapCategoryIds(event.categoryNames, categories)
    const same =
      ids.length === event.categoryIds.length && ids.every((id, i) => id === event.categoryIds[i])
    return same ? event : { ...event, categoryIds: ids }
  })
}

/**
 * The selected category ids after the list changed (a category was created, deleted or replaced
 * by the server's copy). An id that still exists stays; the id of an auto category whose name has
 * become a real category moves to it; any other id is dropped, because a selection nothing can
 * match would hide every event and the sidebar would have no row left to clear it. The same array
 * is returned when nothing changes.
 */
export function reconcileSelection(
  selected: readonly string[],
  categories: readonly Category[],
): readonly string[] {
  const existing = new Set(categories.map((category) => category.id))
  const next: string[] = []
  for (const id of selected) {
    let target: string | undefined
    if (existing.has(id)) target = id
    else if (id.startsWith(AUTO_CATEGORY_PREFIX)) {
      const name = id.slice(AUTO_CATEGORY_PREFIX.length)
      target = categories.find(
        (category) => !isAutoCategory(category) && keyOf(category.name) === name,
      )?.id
    }
    if (target !== undefined && !next.includes(target)) next.push(target)
  }
  const unchanged = next.length === selected.length && next.every((id, i) => id === selected[i])
  return unchanged ? selected : next
}
