import { listCategories } from '../../db/categories'
import { defineApiHandler } from '../../utils/api/handler'

// The caller's own categories and the ones shared with everybody.
export default defineApiHandler((_event, { db, user }) => ({
  categories: listCategories(db, user.id),
}))
