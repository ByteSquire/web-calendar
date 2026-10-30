import { listTokens } from '../../utils/api/app-tokens'
import { defineApiHandler } from '../../utils/api/handler'

// The caller's own app tokens (FR-31), never the secrets.
export default defineApiHandler((_event, { db, user }) => listTokens(db, user.id))
