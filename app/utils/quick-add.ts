// Quick-add form: model, defaults from the preset, validation and the event it produces.
// Pure functions without Vue or Nuxt, so they run in plain Vitest; QuickAddModal.vue renders them.
// The form of the live calendar (description, repeat, ...) builds on this one in
// writes/event-form.ts; the date handling below is shared by both.
import { Temporal } from 'temporal-polyfill'
import { t } from './i18n'
import type { NewEventInput } from './calendar-state'

const DEFAULT_START_TIME = '09:00'
const DEFAULT_END_TIME = '10:00'

/**
 * What the form edits. `start` and `end` hold the value of a date input (`YYYY-MM-DD`) when
 * `allDay`, else of a datetime-local input (`YYYY-MM-DDTHH:mm`), possibly empty while the user
 * edits. For all-day events `end` is the last day (inclusive), which is how people think of
 * "Mon to Wed"; `toNewEventInput` turns it into the exclusive end the calendar state stores.
 */
export interface QuickAddForm {
  title: string
  calendarId: string
  allDay: boolean
  start: string
  end: string
}

export type QuickAddField = 'title' | 'calendarId' | 'start' | 'end'
export type QuickAddErrors = Partial<Record<QuickAddField, string>>

export interface QuickAddDefaults {
  /** The preset `openQuickAdd(preset)` was given, if any. */
  preset: Partial<NewEventInput> | null
  /** Used when the preset has no start date. */
  anchor: Temporal.PlainDate
  /** The calendars the user may add events to, in display order. */
  calendars: readonly { id: string }[]
  visibleCalendarIds: readonly string[]
}

type Boundary = Temporal.PlainDate | Temporal.PlainDateTime

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function parseDate(value: string): Temporal.PlainDate | null {
  if (!DATE.test(value)) return null
  try {
    const date = Temporal.PlainDate.from(value)
    return date.toString() === value ? date : null
  } catch {
    return null
  }
}

function parseDateTime(value: string): Temporal.PlainDateTime | null {
  if (!DATE_TIME.test(value)) return null
  try {
    const dateTime = Temporal.PlainDateTime.from(value)
    return dateTime.toString({ smallestUnit: 'minute' }) === value ? dateTime : null
  } catch {
    return null
  }
}

function parseBoundary(value: string, allDay: boolean): Boundary | null {
  return allDay ? parseDate(value) : parseDateTime(value)
}

function formatDateTime(value: Temporal.PlainDateTime): string {
  return value.toString({ smallestUnit: 'minute' })
}

function compareBoundary(a: Boundary, b: Boundary): number {
  const dateTime = (value: Boundary) =>
    value instanceof Temporal.PlainDate ? value.toPlainDateTime() : value
  return Temporal.PlainDateTime.compare(dateTime(a), dateTime(b))
}

/** The calendar the form starts with: the preset's if it exists, else the first visible one. */
export function defaultQuickAddCalendarId(
  calendars: readonly { id: string }[],
  visibleCalendarIds: readonly string[],
  preferredId?: string,
): string {
  if (preferredId && calendars.some((calendar) => calendar.id === preferredId)) return preferredId
  const visible = calendars.find((calendar) => visibleCalendarIds.includes(calendar.id))
  return (visible ?? calendars[0])?.id ?? ''
}

/**
 * Form values for a freshly opened dialog. The preset uses the calendar state's formats
 * (`YYYY-MM-DD` or local `YYYY-MM-DDTHH:mm[:ss]`, all-day `end` exclusive). Missing or unusable
 * parts fall back to the anchor date, 09:00 and a duration of one hour (one day if all-day).
 */
export function initialQuickAddForm(defaults: QuickAddDefaults): QuickAddForm {
  const { preset, anchor } = defaults
  const allDay = preset?.allDay ?? false
  const base = {
    title: preset?.title ?? '',
    calendarId: defaultQuickAddCalendarId(
      defaults.calendars,
      defaults.visibleCalendarIds,
      preset?.calendarId,
    ),
    allDay,
  }
  const startDate = parseDate(preset?.start?.slice(0, 10) ?? '') ?? anchor

  if (allDay) {
    const endExclusive = parseDate(preset?.end?.slice(0, 10) ?? '')
    const lastDay =
      endExclusive && Temporal.PlainDate.compare(endExclusive, startDate) > 0
        ? endExclusive.subtract({ days: 1 })
        : startDate
    return { ...base, start: startDate.toString(), end: lastDay.toString() }
  }

  const time = preset?.start?.slice(11, 16) ?? ''
  const start = Temporal.PlainDateTime.from(
    `${startDate.toString()}T${TIME.test(time) ? time : DEFAULT_START_TIME}`,
  )
  const presetEnd = parseDateTime(preset?.end?.slice(0, 16) ?? '')
  const end =
    presetEnd && Temporal.PlainDateTime.compare(presetEnd, start) > 0
      ? presetEnd
      : start.add({ hours: 1 })
  return { ...base, start: formatDateTime(start), end: formatDateTime(end) }
}

/**
 * Switches between all-day and timed, converting `start` and `end` to the other input format.
 * Generic so that a form with more fields (writes/event-form.ts) keeps them.
 */
export function setQuickAddAllDay<T extends QuickAddForm>(form: T, allDay: boolean): T {
  if (form.allDay === allDay) return form
  if (!allDay) {
    return {
      ...form,
      allDay,
      start: form.start && `${form.start}T${DEFAULT_START_TIME}`,
      end: form.end && `${form.end}T${DEFAULT_END_TIME}`,
    }
  }
  const start = form.start.slice(0, 10)
  const end = form.end.slice(0, 10)
  return { ...form, allDay, start, end: end < start ? start : end }
}

/** Sets `start` and moves `end` by the same amount, so the duration is kept (like most calendars). */
export function setQuickAddStart<T extends QuickAddForm>(form: T, start: string): T {
  if (form.allDay) {
    const before = parseDate(form.start)
    const after = parseDate(start)
    const end = parseDate(form.end)
    if (!before || !after || !end || Temporal.PlainDate.compare(end, before) < 0) {
      return { ...form, start }
    }
    return { ...form, start, end: after.add(before.until(end)).toString() }
  }
  const before = parseDateTime(form.start)
  const after = parseDateTime(start)
  const end = parseDateTime(form.end)
  if (!before || !after || !end || Temporal.PlainDateTime.compare(end, before) < 0) {
    return { ...form, start }
  }
  return { ...form, start, end: formatDateTime(after.add(before.until(end))) }
}

/** One message per invalid field; an empty object means the form can be submitted. */
export function validateQuickAdd(
  form: QuickAddForm,
  calendarIds: readonly string[],
): QuickAddErrors {
  const errors: QuickAddErrors = {}
  if (!form.title.trim()) errors.title = t('Enter a title.')
  if (!calendarIds.includes(form.calendarId)) errors.calendarId = t('Choose a calendar.')

  const start = parseBoundary(form.start, form.allDay)
  const end = parseBoundary(form.end, form.allDay)
  if (!start)
    errors.start = form.allDay ? t('Enter a start date.') : t('Enter a start date and time.')
  if (!end) {
    errors.end = form.allDay ? t('Enter an end date.') : t('Enter an end date and time.')
  } else if (start) {
    const order = compareBoundary(end, start)
    if (form.allDay && order < 0) errors.end = t('The end date must not be before the start date.')
    if (!form.allDay && order <= 0) errors.end = t('The end must be after the start.')
  }
  return errors
}

/** The input for `addEvent`. The form must have passed `validateQuickAdd`. */
export function toNewEventInput(form: QuickAddForm): NewEventInput {
  return {
    title: form.title.trim(),
    calendarId: form.calendarId,
    allDay: form.allDay,
    start: form.start,
    end: form.allDay ? Temporal.PlainDate.from(form.end).add({ days: 1 }).toString() : form.end,
  }
}
