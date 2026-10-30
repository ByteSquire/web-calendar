// Validation of PUT /api/calendar-prefs (body) and DELETE /api/calendar-prefs (query).
import type { CalendarPrefInput } from '../../db/calendar-prefs'
import {
  FieldErrors,
  finish,
  readCalendarRef,
  readObject,
  readOptionalBoolean,
  readOptionalColor,
  type Parsed,
} from './validation'

/**
 * `{ ref, color?, visible? }`. A field left out stays as stored, `color: null` clears the override.
 * The result only has the keys the client sent.
 */
export function parseCalendarPrefInput(body: unknown): Parsed<CalendarPrefInput> {
  const errors = new FieldErrors()
  const source = readObject(body, errors)
  const ref = readCalendarRef(source.ref, 'ref', errors)
  const color = readOptionalColor(source.color, 'color', errors)
  const visible = readOptionalBoolean(source.visible, 'visible', errors)
  return finish(errors, () => ({ ref: ref!, color, visible }))
}

/** The `ref` query parameter of DELETE. Repeating it (`?ref=a&ref=b`) gives a list and is rejected. */
export function parseCalendarPrefRef(query: unknown): Parsed<string> {
  const errors = new FieldErrors()
  const source = readObject(query, errors)
  const ref = readCalendarRef(source.ref, 'ref', errors)
  return finish(errors, () => ref!)
}
