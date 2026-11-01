import { setResponseStatus } from 'h3'
import { revokeAllTokens } from '../../utils/api/app-tokens'
import { defineApiHandler } from '../../utils/api/handler'

// Revokes every one of the caller's app tokens at once (security review 2026-11-01, finding 3:
// the guide and FR-31 ask for "revoke all", only per-token delete existed before).
export default defineApiHandler((event, { db, user }) => {
  const result = revokeAllTokens(db, user.id)
  setResponseStatus(event, 200)
  return result
})
