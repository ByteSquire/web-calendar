import { getRouterParam } from 'h3'
import { deleteCalendarLink, findCalendarLinkById } from '../../db/calendar-links'
import { notFound } from '../../utils/api/errors'
import { defineMemberHandler } from '../../utils/api/member-handler'
import { parseId } from '../../utils/api/validation'

// Removes one of the caller's links: the address stops working at once, open pages too (every read
// looks the link up). Another person's link answers 404, as one that does not exist.
export default defineMemberHandler((event, { db, user, audit, atomic }) => {
  const id = parseId(getRouterParam(event, 'id'))
  atomic(() => {
    const link = findCalendarLinkById(db, id)
    if (!link || link.user_id !== user.id) throw notFound()
    deleteCalendarLink(db, id)
    audit('calendar_link.deleted', `calendar_link:${id}`, {
      linkId: id,
      calendar: link.collection_path,
      label: link.label,
    })
  })
  return { removed: { id } }
})
