import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { listPeopleForAdmin } from '../../../utils/access/people'

// Everybody who signed in once, for Admin › People (admins only). No e-mail address.
export default defineAdminHandler((_event, { db }) => listPeopleForAdmin(db))
