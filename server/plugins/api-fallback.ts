import { installApiFallback } from '../utils/api/not-found'

// Keeps the SPA shell out of /api/** (L4); the logic is in utils/api/not-found.ts.
export default defineNitroPlugin((nitroApp) => {
  installApiFallback(nitroApp.hooks)
})
