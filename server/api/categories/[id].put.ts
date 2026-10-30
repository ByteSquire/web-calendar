import { getRouterParam, readBody } from 'h3'
import { updateCategory } from '../../db/categories'
import { parseCategoryInput } from '../../utils/api/categories'
import { found } from '../../utils/api/errors'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid, parseId } from '../../utils/api/validation'

// Own categories only; a shared category is read-only and answers 404 like any id that is not yours.
export default defineApiHandler(async (event, { db, user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const input = expectValid(parseCategoryInput(await readBody(event)))
  return found(updateCategory(db, user.id, id, input))
})
