import { readBody } from 'h3'
import { setCalendarPref } from '../../db/calendar-prefs'
import { parseCalendarPrefInput } from '../../utils/api/calendar-prefs'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid } from '../../utils/api/validation'

// Creates or changes the caller's preference for one calendar; a field left out keeps its value.
export default defineApiHandler(async (event, { db, user }) => {
  const input = expectValid(parseCalendarPrefInput(await readBody(event)))
  return setCalendarPref(db, user.id, input)
})
