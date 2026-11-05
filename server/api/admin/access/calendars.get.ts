import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { listAccessCalendars } from '../../../utils/access/service'

// The calendars with their access rules and whether Radicale has them (FR-14).
export default defineAdminHandler((_event, { db }) => ({
  calendars: listAccessCalendars(db),
}))
