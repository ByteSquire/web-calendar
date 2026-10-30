import { getRouterParam, setResponseHeader } from 'h3'
import { findVisibleIcalSubscription } from '../../../db/ical-subscriptions'
import { found } from '../../../utils/api/errors'
import { defineApiHandler } from '../../../utils/api/handler'
import { parseId } from '../../../utils/api/validation'
import { getIcalProxy, toGatewayError } from '../../../utils/ical-proxy/nitro'

// The raw .ics of a subscription, fetched by the server because browsers cannot read arbitrary
// URLs (FR-7). Works for the user's own and for shared subscriptions. A failure is a 502 whose
// `data.reason` says why; stale data is never served.
export default defineApiHandler(async (event, { db, user }) => {
  const subscription = found(
    findVisibleIcalSubscription(db, user.id, parseId(getRouterParam(event, 'id'))),
  )
  try {
    const document = await getIcalProxy().get(subscription.url, {
      userId: user.id,
      subscriptionId: subscription.id,
    })
    setResponseHeader(event, 'content-type', 'text/calendar; charset=utf-8')
    // The body is somebody else's file: the browser must take the type as given, not guess HTML.
    setResponseHeader(event, 'x-content-type-options', 'nosniff')
    if (document.etag) setResponseHeader(event, 'etag', document.etag)
    return document.body
  } catch (error) {
    throw toGatewayError(error)
  }
})
