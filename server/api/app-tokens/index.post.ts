import { readBody, setResponseStatus } from 'h3'
import { createToken } from '../../utils/api/app-tokens'
import { apiConfig } from '../../utils/api/config'
import { defineApiHandler } from '../../utils/api/handler'

// Creates an app token. The secret is in this response only.
export default defineApiHandler(async (event, { db, user }) => {
  const created = createToken(db, apiConfig().tokenHashKey, user.id, await readBody(event))
  setResponseStatus(event, 201)
  return created
})
