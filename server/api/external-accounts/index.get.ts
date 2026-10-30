import { defineApiHandler } from '../../utils/api/handler'
import { listAccounts } from '../../utils/external/accounts'
import { getSealer } from '../../utils/external/nitro'

// The user's external CalDAV accounts (FR-8), and whether this server can seal a login.
export default defineApiHandler((_event, { db, user }) => listAccounts(db, getSealer(), user.id))
