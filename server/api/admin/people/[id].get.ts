import { getRouterParam } from 'h3'
import { getPersonForAdmin } from '../../../utils/access/people'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { found } from '../../../utils/api/errors'
import { parseId } from '../../../utils/api/validation'

// One person for Admin › People: their groups, own calendars, calendars shared with them and the
// links they made (no secrets). Read only.
export default defineAdminHandler((event, { db }) =>
  found(getPersonForAdmin(db, parseId(getRouterParam(event, 'id')))),
)
