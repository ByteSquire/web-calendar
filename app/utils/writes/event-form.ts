// The form of the live calendar's dialogs: "Quick add" creates an event, "Edit" changes one. It
// extends the quick-add form (title, calendar, all day, start, end: app/utils/quick-add.ts) with
// description, location, status, categories and a repeat rule, and maps it to the iCalendar
// writer's input (app/utils/ical/write-types.ts). Pure functions, no Vue.
//
// Times are display-zone wall clock as in the rest of the app. In the form an all-day `end` is the
// last day (inclusive); the writer wants the exclusive end, `toWallClockRange` converts.
import { Temporal } from 'temporal-polyfill'
import type { CalendarEvent, EventStatus } from '../../../shared/types/calendar'
import type {
  EventChanges,
  NewEventInput,
  NewEventRecurrence,
  RecurrenceFrequency,
  WallClockRange,
} from '../ical/write-types'
import {
  initialQuickAddForm,
  parseDate,
  validateQuickAdd,
  type QuickAddDefaults,
  type QuickAddErrors,
  type QuickAddForm,
} from '../quick-add'

export type RepeatKind = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'
export type RepeatEnds = 'never' | 'on' | 'after'

export const REPEAT_KINDS: readonly RepeatKind[] = ['none', 'daily', 'weekly', 'monthly', 'yearly']

export const REPEAT_LABELS: Record<RepeatKind, string> = {
  none: 'Does not repeat',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
}

export const REPEAT_ENDS_LABELS: Record<RepeatEnds, string> = {
  never: 'Never',
  on: 'On a date',
  after: 'After a number of times',
}

/** Most repeats the form accepts; a limit that keeps the expanded REPORT small. */
export const MAX_REPEAT_COUNT = 999

export interface EventForm extends QuickAddForm {
  description: string
  location: string
  status: EventStatus
  /** The names in the iCal `CATEGORIES`; the form edits names, the app resolves ids from them. */
  categoryNames: string[]
  repeat: RepeatKind
  repeatEnds: RepeatEnds
  /** `YYYY-MM-DD`, while `repeatEnds` is `on`. */
  repeatUntil: string
  /** A whole number, while `repeatEnds` is `after`; a string because the input is one. */
  repeatCount: string
}

export type EventFormField = keyof QuickAddErrors | 'repeatUntil' | 'repeatCount'
export type EventFormErrors = Partial<Record<EventFormField, string>>

const FREQUENCIES: Record<Exclude<RepeatKind, 'none'>, RecurrenceFrequency> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
}

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

const FORM_EXTRAS = {
  description: '',
  location: '',
  status: 'confirmed',
  categoryNames: [],
  repeat: 'none',
  repeatEnds: 'never',
  repeatUntil: '',
  repeatCount: '10',
} as const satisfies Omit<EventForm, keyof QuickAddForm>

/** The form of a freshly opened "Quick add": the quick-add defaults, no description, no repeat. */
export function initialEventForm(defaults: QuickAddDefaults): EventForm {
  return { ...initialQuickAddForm(defaults), ...FORM_EXTRAS, categoryNames: [] }
}

/**
 * The form of "Edit", from the event as the calendar state holds it (display-zone wall clock,
 * all-day `end` exclusive). Times are cut to the minute, which is what the inputs show.
 */
export function eventFormFromEvent(
  event: Pick<
    CalendarEvent,
    | 'title'
    | 'calendarId'
    | 'allDay'
    | 'start'
    | 'end'
    | 'status'
    | 'description'
    | 'location'
    | 'categoryNames'
  >,
): EventForm {
  const common = {
    ...FORM_EXTRAS,
    title: event.title,
    calendarId: event.calendarId,
    allDay: event.allDay,
    status: event.status,
    description: event.description ?? '',
    location: event.location ?? '',
    categoryNames: [...(event.categoryNames ?? [])],
  }
  if (event.allDay) {
    const start = parseDate(event.start.slice(0, 10))
    const exclusiveEnd = parseDate(event.end.slice(0, 10))
    const last =
      start && exclusiveEnd && Temporal.PlainDate.compare(exclusiveEnd, start) > 0
        ? exclusiveEnd.subtract({ days: 1 })
        : start
    return {
      ...common,
      start: event.start.slice(0, 10),
      end: last ? last.toString() : event.end.slice(0, 10),
    }
  }
  return { ...common, start: event.start.slice(0, 16), end: event.end.slice(0, 16) }
}

// ---------------------------------------------------------------------------------------------
// Validation

function sameTimes(a: QuickAddForm, b: QuickAddForm): boolean {
  return a.allDay === b.allDay && a.start === b.start && a.end === b.end
}

export interface ValidateOptions {
  /** Edit: the form as it was opened. Times that were not touched are not checked again. */
  original?: EventForm
}

/** One message per invalid field; an empty object means the form can be submitted. */
export function validateEventForm(
  form: EventForm,
  calendarIds: readonly string[],
  options: ValidateOptions = {},
): EventFormErrors {
  const errors: EventFormErrors = validateQuickAdd(form, calendarIds)
  // An event someone else made may have no length at all; leaving its time alone is fine.
  if (options.original && sameTimes(form, options.original)) {
    delete errors.start
    delete errors.end
  }
  if (form.repeat === 'none') return errors

  if (form.repeatEnds === 'on') {
    const until = parseDate(form.repeatUntil)
    // The last day counts whole: a repeat that ends on the day of the start has that one event.
    const startDay = parseDate(form.start.slice(0, 10))
    if (!until) errors.repeatUntil = 'Enter the last date of the repeat.'
    else if (startDay && Temporal.PlainDate.compare(until, startDay) < 0) {
      errors.repeatUntil = 'The repeat must not end before the event starts.'
    }
  } else if (form.repeatEnds === 'after') {
    const count = /^\d{1,4}$/.test(form.repeatCount.trim()) ? Number(form.repeatCount) : NaN
    if (!Number.isInteger(count) || count < 1 || count > MAX_REPEAT_COUNT) {
      errors.repeatCount = `Enter a number from 1 to ${MAX_REPEAT_COUNT}.`
    }
  }
  return errors
}

// ---------------------------------------------------------------------------------------------
// Form to writer input

/** The exclusive end day of an all-day range, which the form holds as the last day. */
function exclusiveEnd(lastDay: string): string {
  return Temporal.PlainDate.from(lastDay).add({ days: 1 }).toString()
}

/** The form's range as the writer takes it. The form must have passed `validateEventForm`. */
export function toWallClockRange(form: QuickAddForm): WallClockRange {
  return {
    start: form.start,
    end: form.allDay ? exclusiveEnd(form.end) : form.end,
    allDay: form.allDay,
  }
}

/** The repeat rule of the form: weekly on the start's weekday, monthly on its day of the month. */
export function recurrenceFromForm(form: EventForm): NewEventRecurrence | undefined {
  if (form.repeat === 'none') return undefined
  const day = Temporal.PlainDate.from(form.start.slice(0, 10))
  const rule: NewEventRecurrence = { freq: FREQUENCIES[form.repeat] }
  if (form.repeat === 'weekly') rule.byDay = [WEEKDAYS[day.dayOfWeek - 1]!]
  if (form.repeat === 'monthly') rule.byMonthDay = [day.day]
  if (form.repeatEnds === 'on') rule.until = form.repeatUntil
  if (form.repeatEnds === 'after') rule.count = Number(form.repeatCount)
  return rule
}

/** The input of `createEventResource` (not the demo store's `NewEventInput`). */
export function toWriterNewEvent(form: EventForm): NewEventInput {
  const description = form.description.trim()
  const location = form.location.trim()
  const recurrence = recurrenceFromForm(form)
  return {
    title: form.title.trim(),
    when: toWallClockRange(form),
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(recurrence ? { recurrence } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// Edit: what changed

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sorted = (names: readonly string[]) => [...names].sort()
  const left = sorted(a)
  const right = sorted(b)
  return left.every((name, index) => name === right[index])
}

/**
 * Only the fields that differ from the form as it was opened. Both sides are compared the way the
 * inputs show them (times to the minute, trimmed text, an empty description equal to none), so an
 * untouched field never turns into a change: a `when` rebuilt from a form that cut the seconds
 * would move the event. A cleared description or location is `null` (remove the line).
 */
export function diffEventForm(original: EventForm, current: EventForm): EventChanges {
  const changes: EventChanges = {}
  const title = current.title.trim()
  if (title !== original.title.trim()) changes.title = title
  const description = current.description.trim()
  if (description !== original.description.trim()) {
    changes.description = description === '' ? null : description
  }
  const location = current.location.trim()
  if (location !== original.location.trim()) changes.location = location === '' ? null : location
  if (current.status !== original.status) changes.status = current.status
  if (!sameNames(current.categoryNames, original.categoryNames)) {
    changes.categoryNames = current.categoryNames.map((name) => name.trim()).filter(Boolean)
  }
  if (!sameTimes(current, original)) changes.when = toWallClockRange(current)
  return changes
}
