import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { accessConfig } from '../../../utils/access/config'
import { listAccessCalendars } from '../../../utils/access/service'

// The calendars with their access rules and whether Radicale has them (FR-14).
export default defineAdminHandler((_event, { db }) => ({
  calendars: listAccessCalendars(db),
  // Without the sync token the app cannot check a group, so the page offers none.
  groupsAvailable: accessConfig().kanidm !== null,
}))
