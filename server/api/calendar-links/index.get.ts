import { listCalendarLinksOfUser } from '../../db/calendar-links'
import { apiConfig } from '../../utils/api/config'
import { defineApiHandler } from '../../utils/api/handler'
import { linkView } from '../../utils/links/service'

// The caller's calendar links, with their addresses (no password: that is asked for one at a time,
// server/api/calendar-links/[id]/reveal.post.ts). Not cached anywhere (defineApiHandler: no-store).
export default defineApiHandler((_event, { db, user }) => {
  const { tokenHashKey } = apiConfig()
  return { links: listCalendarLinksOfUser(db, user.id).map((link) => linkView(tokenHashKey, link)) }
})
