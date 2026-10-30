import { getRouterParam, setResponseStatus } from 'h3'
import { defineApiHandler } from '../../utils/api/handler'
import { parseId } from '../../utils/api/validation'
import { removeAccount } from '../../utils/external/accounts'

// Removes one of the user's own accounts; someone else's answers 404.
export default defineApiHandler((event, { db, user }) => {
  removeAccount(db, user.id, parseId(getRouterParam(event, 'id')))
  setResponseStatus(event, 204)
  return null
})
