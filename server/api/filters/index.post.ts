import { readBody, setResponseStatus } from 'h3'
import { createFilter } from '../../db/filters'
import { parseFilterInput } from '../../utils/api/filters'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid } from '../../utils/api/validation'

export default defineApiHandler(async (event, { db, user }) => {
  const input = expectValid(parseFilterInput(await readBody(event)))
  const filter = createFilter(db, user.id, input)
  setResponseStatus(event, 201)
  return filter
})
