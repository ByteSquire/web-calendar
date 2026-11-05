import { listGroupSummaries } from '../../db/groups'
import { defineApiHandler } from '../../utils/api/handler'
import { groupSummary } from '../../utils/groups/service'

// Every group, of either source, for any signed-in user. `member` says whether the caller is in it.
export default defineApiHandler((_event, { db, user }) => ({
  groups: listGroupSummaries(db, user.sub).map(groupSummary),
}))
