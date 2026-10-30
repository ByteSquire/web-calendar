import { getQuery, setResponseStatus } from 'h3'
import { deleteCalendarPref } from '../../db/calendar-prefs'
import { parseCalendarPrefRef } from '../../utils/api/calendar-prefs'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid } from '../../utils/api/validation'

// Resets the caller's preference for `?ref=`; quiet when there is none.
export default defineApiHandler((event, { db, user }) => {
  deleteCalendarPref(db, user.id, expectValid(parseCalendarPrefRef(getQuery(event))))
  setResponseStatus(event, 204)
  return null
})
