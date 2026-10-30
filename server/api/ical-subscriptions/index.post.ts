import { readBody, setResponseStatus } from 'h3'
import { defineApiHandler } from '../../utils/api/handler'
import { getIcalPolicy } from '../../utils/ical-proxy/nitro'
import { addSubscription } from '../../utils/ical-proxy/subscriptions'

// Subscribes the user to an .ics URL. The address is checked against the SSRF rules right here.
export default defineApiHandler(async (event, { db, user }) => {
  const created = await addSubscription(db, getIcalPolicy(), user.id, await readBody(event))
  setResponseStatus(event, 201)
  return created
})
