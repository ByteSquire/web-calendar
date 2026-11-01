import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { listAccessUsers } from '../../../utils/access/service'

// The people an admin can pick: those who signed in once. Name and username only.
export default defineAdminHandler((_event, { db }) => ({ users: listAccessUsers(db) }))
