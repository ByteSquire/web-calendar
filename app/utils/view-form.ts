// The view dialog (ViewDialog.vue) and "Update from selection" (FR-2, FR-21): which calendars a
// view can hold, what it holds after a choice, and what is wrong with a draft. Pure, so it runs in
// plain Vitest (tests/view-form.test.ts).
import type { Calendar, CalendarView } from '../../shared/types/calendar'
import { t } from './i18n'
import { isSharedViewRef } from './live/admin-views'
import { VIEW_NAME_MAX } from './live/user-views'

/**
 * The calendars of the viewer that a view can hold, in the sidebar's order: no resources (a view
 * names none, and the server refuses them), and in a shared view no external ones (an
 * administrator must not steer people's own accounts).
 */
export function offeredViewCalendars(calendars: readonly Calendar[], shared: boolean): Calendar[] {
  return calendars.filter(
    (calendar) => calendar.type !== 'resource' && (!shared || isSharedViewRef(calendar.id)),
  )
}

/**
 * The view's calendars once `chosen` are picked among `offered`: the chosen ones in the order of
 * `offered`, then those of `current` that were not offered (calendars the viewer cannot see, such
 * as a deleted one or one of a shared view that is not shared with them), which stay.
 */
export function chosenViewCalendarIds(
  current: readonly string[],
  offered: readonly Pick<Calendar, 'id'>[],
  chosen: readonly string[],
): string[] {
  const offeredIds = new Set(offered.map((calendar) => calendar.id))
  const picked = new Set(chosen)
  const kept = current.filter((id) => !offeredIds.has(id))
  return [...new Set([...offered.map((c) => c.id).filter((id) => picked.has(id)), ...kept])]
}

/** How many of a view's calendars the dialog does not offer, and keeps. */
export function hiddenViewCalendarCount(
  current: readonly string[],
  offered: readonly Pick<Calendar, 'id'>[],
): number {
  const offeredIds = new Set(offered.map((calendar) => calendar.id))
  return new Set(current.filter((id) => !offeredIds.has(id))).size
}

/**
 * The names a view may not take: those of the other views of its kind (a person's own views among
 * themselves, the shared ones among themselves).
 */
export function takenViewNames(
  views: readonly CalendarView[],
  shared: boolean,
  exceptId?: string,
): string[] {
  return views
    .filter((view) => view.isAdmin === shared && view.id !== exceptId)
    .map((view) => view.name)
}

export interface ViewProblems {
  name?: string
  calendars?: string
}

/** What is wrong with a view as the dialog has it; empty when it can be saved. */
export function checkViewDraft(
  name: string,
  calendarCount: number,
  taken: readonly string[],
): ViewProblems {
  const problems: ViewProblems = {}
  const trimmed = name.trim()
  if (!trimmed) problems.name = t('Enter a name.')
  else if (trimmed.length > VIEW_NAME_MAX) {
    problems.name = t('Use at most {count} characters.', { count: VIEW_NAME_MAX })
  } else if (taken.some((other) => other.toLowerCase() === trimmed.toLowerCase())) {
    problems.name = t('A view with this name already exists.')
  }
  if (calendarCount === 0) problems.calendars = t('Choose at least one calendar.')
  return problems
}
