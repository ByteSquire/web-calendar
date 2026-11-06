import { getRouterParam, readBody } from 'h3'
import { updateSharedCategory } from '../../../db/categories'
import { defineAdminHandler } from '../../../utils/api/admin-handler'
import { parseCategoryInput } from '../../../utils/api/categories'
import { found } from '../../../utils/api/errors'
import { expectValid, parseId } from '../../../utils/api/validation'

// Renames or recolours a category shared with everybody (admins only). Own categories go through
// /api/categories; an id that is not a shared category answers 404.
export default defineAdminHandler(async (event, { db, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const input = expectValid(parseCategoryInput(await readBody(event)))
  return atomic(() => {
    const category = found(updateSharedCategory(db, id, input))
    audit('category.shared_changed', `category:${id}`, { name: category.name })
    return category
  })
})
