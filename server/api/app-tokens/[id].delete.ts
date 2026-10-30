import { getRouterParam, setResponseStatus } from 'h3'
import { revokeToken } from '../../utils/api/app-tokens'
import { defineApiHandler } from '../../utils/api/handler'

// Revokes one of the caller's tokens at once; 404 for any other id.
export default defineApiHandler((event, { db, user }) => {
  revokeToken(db, user.id, getRouterParam(event, 'id'))
  setResponseStatus(event, 204)
  return null
})
