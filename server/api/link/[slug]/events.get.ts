import { createError, getQuery, getRequestHeader, getRouterParam } from 'h3'
import { apiConfig } from '../../../utils/api/config'
import { getDb } from '../../../utils/db'
import { getLinkLimits, getLinkReader, linkClientKey } from '../../../utils/links/ports'
import { definePublicLinkHandler, tooMany } from '../../../utils/links/public-handler'
import { parseRange, readCalendarLink } from '../../../utils/links/service'

/** The header that carries the session of the page (never a cookie, never the address). */
const SESSION_HEADER = 'x-calendar-link-session'

// What a calendar link shows in `from`..`to` (ISO date-times, at most 400 days), read as the link's
// principal (its maker, or the calendar's owner for a link of the access page): at "Can view"
// Radicale's objects unchanged, at "Busy times only" its VFREEBUSY alone.
export default definePublicLinkHandler(async (event) => {
  const wait = getLinkLimits().readsPerAddress.take(linkClientKey(event))
  if (wait !== null) tooMany(event, wait)
  const query = getQuery(event)
  const range = parseRange(query.from, query.to)
  if (!range.ok) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'from and to must be date-times, at most 400 days apart',
    })
  }
  const { tokenHashKey, signinWindowMs } = apiConfig()
  return readCalendarLink(
    { db: getDb(), keyring: tokenHashKey, windowMs: signinWindowMs, reader: getLinkReader() },
    getRouterParam(event, 'slug') ?? '',
    getRequestHeader(event, SESSION_HEADER),
    range,
  )
})
