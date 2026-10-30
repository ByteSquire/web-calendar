import { defineApiHandler } from '../../utils/api/handler'
import { listViews } from '../../db/views'

// The caller's own views and all admin views.
export default defineApiHandler((_event, { db, user }) => ({ views: listViews(db, user.id) }))
