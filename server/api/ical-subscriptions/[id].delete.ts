import { getRouterParam, setResponseStatus } from 'h3'
import { defineApiHandler } from '../../utils/api/handler'
import { parseId } from '../../utils/api/validation'
import { removeSubscription } from '../../utils/ical-proxy/subscriptions'

// Removes one of the user's own subscriptions; a shared one is read-only and answers 404.
export default defineApiHandler((event, { db, user }) => {
  removeSubscription(db, user.id, parseId(getRouterParam(event, 'id')))
  setResponseStatus(event, 204)
  return null
})
