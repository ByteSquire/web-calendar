import { getRouterParam, readBody } from 'h3'
import { updateView } from '../../db/views'
import { found } from '../../utils/api/errors'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid, parseId } from '../../utils/api/validation'
import { parseViewInput } from '../../utils/api/views'

// Replaces one of the caller's own views; admin views and other users' views are 404.
export default defineApiHandler(async (event, { db, user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const input = expectValid(parseViewInput(await readBody(event)))
  return found(updateView(db, user.id, id, input))
})
