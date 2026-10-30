import { readBody, setResponseStatus } from 'h3'
import { createView } from '../../db/views'
import { defineApiHandler } from '../../utils/api/handler'
import { expectValid } from '../../utils/api/validation'
import { parseViewInput } from '../../utils/api/views'

export default defineApiHandler(async (event, { db, user }) => {
  const input = expectValid(parseViewInput(await readBody(event)))
  const view = createView(db, user.id, input)
  setResponseStatus(event, 201)
  return view
})
