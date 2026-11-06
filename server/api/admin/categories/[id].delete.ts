import { getRouterParam, setResponseStatus } from 'h3'
import { deleteSharedCategory } from '../../../db/categories'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { found } from '../../../utils/api/errors'
import { parseId } from '../../../utils/api/validation'

// Deletes a category shared with everybody (admins only). Events carry categories as text, so no
// event changes; an id that is not a shared category answers 404.
export default defineAdminHandler((event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  atomic(() => {
    const category = found(deleteSharedCategory(db, id))
    audit('category.shared_deleted', `category:${id}`, { name: category.name })
  })
  setResponseStatus(event, 204)
  return null
})
