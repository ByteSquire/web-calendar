// Types of the write side of iCalendar handling (create an event, edit one without losing what
// other clients put into it). Wall-clock strings are always in the DISPLAY zone of the person who
// edits; the functions in write.ts convert them to the zone the event itself is written in.

/** A time range as the editor shows it: display-zone wall clock, an all-day `end` is exclusive. */
export interface WallClockRange {
  /** `YYYY-MM-DDTHH:mm[:ss]`, or `YYYY-MM-DD` when `allDay`. */
  start: string
  /** Same format as `start`; for an all-day range the day after the last day. */
  end: string
  allDay: boolean
}

export type EventStatusValue = 'confirmed' | 'tentative' | 'cancelled'

/** What the user changed. `undefined` leaves a field alone, `null` removes it. */
export interface EventChanges {
  title?: string
  description?: string | null
  location?: string | null
  status?: EventStatusValue
  categoryNames?: string[]
  when?: WallClockRange
}

/**
 * Which part of a recurring event an edit or delete is about. `recurrenceId` is the contract string
 * of `CalendarEvent.recurrenceId`: the UTC instant of the ORIGINAL slot (`2026-10-26T08:00:00Z`) or a
 * date (`2026-11-05`) for an all-day series.
 *
 * `series` may name the occurrence the editor was opened from: `changes.when` then describes THAT
 * occurrence and the whole series moves by the same wall-clock delta. Without it `when` is the new
 * range of the series' first occurrence (its DTSTART).
 */
export type EditScope =
  | { kind: 'series'; recurrenceId?: string }
  | { kind: 'instance'; recurrenceId: string }
  | { kind: 'thisAndFollowing'; recurrenceId: string }

export interface WriteContext {
  /** The editor's zone: the zone of every wall-clock string in the changes. */
  displayTimeZone: string
  /** Reads floating times; the zone floating events are edited in. */
  orgTimeZone: string
  /** The clock for DTSTAMP, LAST-MODIFIED and UNTIL-less defaults; tests pin it. */
  now?: Date
}

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface NewEventRecurrence {
  freq: RecurrenceFrequency
  interval?: number
  /** `MO`, `TU`, ... with an optional ordinal such as `-1FR` or `2TU`. */
  byDay?: string[]
  byMonthDay?: number[]
  byMonth?: number[]
  bySetPos?: number[]
  count?: number
  /** Inclusive end, display-zone wall clock (`YYYY-MM-DDTHH:mm[:ss]`) or a date (`YYYY-MM-DD`). */
  until?: string
}

export interface NewEventInput {
  title: string
  when: WallClockRange
  description?: string
  location?: string
  status?: EventStatusValue
  categoryNames?: string[]
  recurrence?: NewEventRecurrence
}

/** A resource created from scratch: the iCal UID and the complete `.ics` text. */
export interface NewEventResource {
  uid: string
  ics: string
}

/**
 * The outcome of an edit. `updated` is the new text of the resource that was edited, or `null` when
 * nothing is left of it (delete the resource). `created` is a second resource, written when a series
 * was split ("this and following").
 */
export interface EditResult {
  updated: string | null
  created: NewEventResource | null
}

export type EditErrorCode =
  /** The recurrence id is not an occurrence of the series (never was, or already deleted). */
  | 'unknown-instance'
  /** The input is wrong: malformed or inverted times, an empty title, an unknown zone. */
  | 'invalid-input'
  /** The resource text is not iCalendar this module can read. */
  | 'unparseable'
  /** Valid, but not something this module edits (for example an unknown TZID without VTIMEZONE). */
  | 'unsupported'

export class EditError extends Error {
  readonly code: EditErrorCode

  constructor(code: EditErrorCode, message: string) {
    super(message)
    this.name = 'EditError'
    this.code = code
  }
}
