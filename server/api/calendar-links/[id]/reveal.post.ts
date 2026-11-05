import { getRouterParam } from 'h3'
import { findCalendarLinkById } from '../../../db/calendar-links'
import { apiConfig } from '../../../utils/api/config'
import { ApiError, notFound } from '../../../utils/api/errors'
import { defineMemberHandler } from '../../../utils/api/member-handler'
import { parseId } from '../../../utils/api/validation'
import { linkPassword } from '../../../utils/links/service'

// The password of one of the caller's links, for "Show" and "Copy". A POST, so nothing keeps it; each
// time is in the audit log. Another person's link answers 404.
export default defineMemberHandler((event, { db, user, audit }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const link = findCalendarLinkById(db, id)
  if (!link || link.user_id !== user.id) throw notFound()
  const password = linkPassword(apiConfig().tokenHashKey, link)
  if (password === null) {
    throw new ApiError(409, 'The password of this link cannot be shown; make a new link', {
      code: 'not_available',
    })
  }
  audit('calendar_link.revealed', `calendar_link:${id}`, { linkId: id })
  return { password }
})
