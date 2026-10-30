// Validation of PUT /api/me/time-zone (FR-32): the zone the caller wants to see times in.
import { isValidTimeZone } from '../../../shared/utils/time-zone'
import { FieldErrors, finish, readObject, type Parsed } from './validation'

/** The longest IANA name is 32 characters (`America/Argentina/ComodRivadavia`). */
export const MAX_TIME_ZONE_LENGTH = 64

/**
 * What IANA names are made of: letters, digits and `_ + -` in parts separated by `/`. The first
 * character is a letter, which keeps out the UTC offsets (`+01:00`) that newer engines accept as
 * zones. This is a gate in front of `Intl`, not the check: a match can still be no zone.
 */
const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+/-]*$/

/**
 * `{ timeZone }`: an IANA name such as `Europe/Berlin`, or `null` to use the browser's zone. The
 * field is required, so a body without it cannot clear the setting by accident. The name is kept
 * as sent (no trimming, no change of case) and the messages never repeat it.
 */
export function parseTimeZoneInput(body: unknown): Parsed<{ timeZone: string | null }> {
  const errors = new FieldErrors()
  const value = readObject(body, errors).timeZone
  let timeZone: string | null = null
  if (value === undefined) {
    errors.add('timeZone', 'is required')
  } else if (value !== null) {
    if (typeof value !== 'string') {
      errors.add('timeZone', 'must be a string or null')
    } else if (value.length > MAX_TIME_ZONE_LENGTH) {
      errors.add('timeZone', `must have at most ${MAX_TIME_ZONE_LENGTH} characters`)
    } else if (!TIME_ZONE_PATTERN.test(value) || !isValidTimeZone(value)) {
      errors.add('timeZone', 'must be a time zone name such as Europe/Berlin')
    } else {
      timeZone = value
    }
  }
  return finish(errors, () => ({ timeZone }))
}
