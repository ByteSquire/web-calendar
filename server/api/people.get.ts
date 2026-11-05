import { listPeopleRows } from '../db/groups'
import { defineApiHandler } from '../utils/api/handler'
import { MAX_PEOPLE } from '../utils/groups/rules'
import { personView } from '../utils/groups/service'

// Everybody who has signed in once, for the pickers of the group pages. Names and usernames only:
// no e-mail address and no token, so an ordinary user learns no more than the group pages show.
// At most MAX_PEOPLE; `truncated` says that there are more, so the page can say who is missing.
export default defineApiHandler((_event, { db }) => {
  const rows = listPeopleRows(db, MAX_PEOPLE + 1)
  return { people: rows.slice(0, MAX_PEOPLE).map(personView), truncated: rows.length > MAX_PEOPLE }
})
