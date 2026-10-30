import { listCalendarPrefs } from '../../db/calendar-prefs'
import { defineApiHandler } from '../../utils/api/handler'

export default defineApiHandler((_event, { db, user }) => ({
  prefs: listCalendarPrefs(db, user.id),
}))
