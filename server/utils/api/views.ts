// Validation of the body of POST and PUT /api/views.
import {
  MAX_CALENDARS_PER_VIEW,
  VIEW_ICONS,
  type ViewCalendar,
  type ViewInput,
} from '../../db/views'
import {
  FieldErrors,
  finish,
  readCalendarRef,
  readChoice,
  readObject,
  readOptionalColor,
  readText,
  isRecord,
  type Parsed,
} from './validation'

export const MAX_VIEW_NAME_LENGTH = 80

function readCalendars(
  value: unknown,
  errors: FieldErrors,
  allowExternal: boolean,
): ViewCalendar[] {
  if (value === undefined || value === null) {
    errors.add('calendars', 'is required')
    return []
  }
  if (!Array.isArray(value)) {
    errors.add('calendars', 'must be a list')
    return []
  }
  // Checked before the entries, so an absurd list costs one comparison.
  if (value.length > MAX_CALENDARS_PER_VIEW) {
    errors.add('calendars', `must have at most ${MAX_CALENDARS_PER_VIEW} entries`)
    return []
  }

  const seen = new Set<string>()
  const calendars: ViewCalendar[] = []
  value.forEach((entry: unknown, index) => {
    const path = `calendars[${index}]`
    if (!isRecord(entry)) {
      errors.add(path, 'must be an object with a ref and an optional color')
      return
    }
    const ref = readCalendarRef(entry.ref, `${path}.ref`, errors)
    // An omitted color and `null` both mean "the calendar's own color".
    if (ref?.startsWith('ext:') && !allowExternal) {
      errors.add(`${path}.ref`, 'external calendars are not allowed in shared views')
    }
    const color = readOptionalColor(entry.color, `${path}.color`, errors)
    if (ref === undefined) return
    if (seen.has(ref)) {
      errors.add(`${path}.ref`, 'appears more than once')
      return
    }
    seen.add(ref)
    calendars.push({ ref, color: color ?? null })
  })
  return calendars
}

/**
 * `{ name, icon?, calendars }`. A missing icon becomes `calendar`. Shared (admin) views pass
 * `{ allowExternal: false }`: an admin must not steer users' external accounts (FR-8).
 */
export function parseViewInput(
  body: unknown,
  options: { allowExternal?: boolean } = {},
): Parsed<ViewInput> {
  const errors = new FieldErrors()
  const source = readObject(body, errors)
  const name = readText(source.name, 'name', MAX_VIEW_NAME_LENGTH, errors)
  const icon = readChoice(source.icon, 'icon', VIEW_ICONS, errors, 'calendar')
  const calendars = readCalendars(source.calendars, errors, options.allowExternal ?? true)
  return finish(errors, () => ({ name: name!, icon: icon!, calendars }))
}
