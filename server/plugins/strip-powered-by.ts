import { installPoweredByRemoval } from '../utils/api/powered-by'

// No `X-Powered-By` on any response; the logic is in utils/api/powered-by.ts.
export default defineNitroPlugin((nitroApp) => {
  installPoweredByRemoval(nitroApp.hooks)
})
