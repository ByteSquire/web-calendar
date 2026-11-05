import { listGroupSummaries } from '../../db/groups'
import { defineApiHandler } from '../../utils/api/handler'
import { apiConfig } from '../../utils/api/config'
import { signinCutoff } from '../../utils/auth/window'
import { groupSummary } from '../../utils/groups/service'

// Every group, of every source, for any signed-in user. `member` says whether the caller is in it.
export default defineApiHandler((_event, { db, user }) => ({
  groups: listGroupSummaries(
    db,
    user.sub,
    signinCutoff(apiConfig().signinWindowMs, new Date()),
  ).map(groupSummary),
}))
