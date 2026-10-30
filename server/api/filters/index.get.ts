import { listFilters } from '../../db/filters'
import { defineApiHandler } from '../../utils/api/handler'

export default defineApiHandler((_event, { db, user }) => ({ filters: listFilters(db, user.id) }))
