import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../../utils/api/handler'
import { parseId } from '../../../utils/api/validation'
import { resealAccount } from '../../../utils/external/accounts'
import { getAccountDeps } from '../../../utils/external/nitro'

// A new sealed credential for an existing account (a new device, a cleared browser). Nothing is
// sent to the account's server: the password is sealed, not checked.
export default defineApiHandler(async (event, { user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  return resealAccount(getAccountDeps(), user, id, await readBody(event))
})
