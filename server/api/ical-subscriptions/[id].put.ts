import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../utils/api/handler'
import { parseId } from '../../utils/api/validation'
import { getIcalPolicy } from '../../utils/ical-proxy/nitro'
import { changeSubscription } from '../../utils/ical-proxy/subscriptions'

// Changes one of the user's own subscriptions; a shared one is read-only and answers 404.
export default defineApiHandler(async (event, { db, user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  return changeSubscription(db, getIcalPolicy(), user.id, id, await readBody(event))
})
