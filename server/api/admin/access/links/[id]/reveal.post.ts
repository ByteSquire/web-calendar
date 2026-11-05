import { getRouterParam } from 'h3'
import { findCalendarLinkById } from '../../../../../db/calendar-links'
import { defineAdminHandler } from '../../../../../utils/api/admin-handler'
import { apiConfig } from '../../../../../utils/api/config'
import { ApiError, notFound } from '../../../../../utils/api/errors'
import { parseId } from '../../../../../utils/api/validation'
import { linkPassword } from '../../../../../utils/links/service'

// The password of a link to a calendar of the access page, for "Show" and "Copy"; audited.
export default defineAdminHandler((event, { db, audit }) => {
  const id = parseId(getRouterParam(event, 'id'))
  const link = findCalendarLinkById(db, id)
  if (!link || link.calendar_id === null) throw notFound()
  const password = linkPassword(apiConfig().tokenHashKey, link)
  if (password === null) {
    throw new ApiError(409, 'The password of this link cannot be shown; make a new link', {
      code: 'not_available',
    })
  }
  audit('calendar_link.revealed', `calendar_link:${id}`, { linkId: id, byAdmin: true })
  return { password }
})
