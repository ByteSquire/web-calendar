import { getRouterParam, readBody } from 'h3'
import { defineApiHandler } from '../../utils/api/handler'
import { parseId } from '../../utils/api/validation'
import { changeAccount } from '../../utils/external/accounts'
import { getAccountDeps } from '../../utils/external/nitro'

// Changes one of the user's own accounts. A new address, user name or login needs the password
// again (the old seal is void) and the answer holds the new seal.
export default defineApiHandler(async (event, { user }) => {
  const id = parseId(getRouterParam(event, 'id'))
  return changeAccount(getAccountDeps(), user, id, await readBody(event))
})
