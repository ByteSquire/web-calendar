import { getRouterParam, readBody } from 'h3'
import { updateFilter } from '../../db/filters'
import { found } from '../../utils/api/errors'
import { parseFilterInput } from '../../utils/api/filters'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid, parseId } from '../../utils/api/validation'

export default defineApiHandler(async (event, { db, user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const input = expectValid(parseFilterInput(await readBody(event)))
  return found(updateFilter(db, user.id, id, input))
})
