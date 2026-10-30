import { readBody, setResponseStatus } from 'h3'
import { defineApiHandler } from '../../utils/api/handler'
import { addAccount } from '../../utils/external/accounts'
import { getAccountDeps } from '../../utils/external/nitro'

// Adds an external CalDAV account. For a login the answer holds the sealed credential, the only
// copy the browser gets to keep (the password is not stored). The address is checked against the
// host policy right here.
export default defineApiHandler(async (event, { user }) => {
  const created = await addAccount(getAccountDeps(), user, await readBody(event))
  setResponseStatus(event, 201)
  return created
})
