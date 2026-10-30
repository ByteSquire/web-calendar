import { readBody } from 'h3'
import { setUserTimeZone } from '../../db/users'
import { defineApiHandler } from '../../utils/api/handler'
import { parseTimeZoneInput } from '../../utils/api/time-zone'
import { expectValid } from '../../utils/api/validation'

// Sets the zone the caller sees times in (FR-32), or clears it (`null`) so the browser's zone
// applies again. The answer is the stored value.
export default defineApiHandler(async (event, { db, user }) => {
  const { timeZone } = expectValid(parseTimeZoneInput(await readBody(event)))
  return { timeZone: setUserTimeZone(db, user.id, timeZone) }
})
