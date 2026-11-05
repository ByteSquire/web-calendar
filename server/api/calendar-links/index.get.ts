import { listCalendarLinks } from '../../db/calendar-links'
import { defineApiHandler } from '../../utils/api/handler'

// The caller's calendar links (no secrets: the address was shown once, the password is a hash).
export default defineApiHandler((_event, { db, user }) => ({
  links: listCalendarLinks(db, user.id),
}))
