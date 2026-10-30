import { readBody, setResponseStatus } from 'h3'
import { createCategory } from '../../db/categories'
import { parseCategoryInput } from '../../utils/api/categories'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid } from '../../utils/api/validation'

export default defineApiHandler(async (event, { db, user }) => {
  const input = expectValid(parseCategoryInput(await readBody(event)))
  const category = createCategory(db, user.id, input)
  setResponseStatus(event, 201)
  return category
})
