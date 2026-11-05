import { listPeopleRows } from '../db/groups'
import { defineApiHandler } from '../utils/api/handler'
import { MAX_PEOPLE } from '../utils/groups/rules'
import { personView } from '../utils/groups/service'

// Everybody who has signed in once, for the pickers of the group pages. Names and usernames only:
// no e-mail address and no token, so an ordinary user learns no more than the group pages show.
export default defineApiHandler((_event, { db }) => ({
  people: listPeopleRows(db, MAX_PEOPLE).map(personView),
}))
