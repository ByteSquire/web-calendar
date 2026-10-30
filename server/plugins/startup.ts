import { installStartupChecks } from '../utils/api/startup'

// Fails fast on a bad configuration (L2); the checks are in utils/api/startup.ts.
export default defineNitroPlugin((nitroApp) => {
  // The build renders the SPA shell through this server; it has no config to check.
  if (import.meta.prerender) return
  installStartupChecks(nitroApp.hooks, { demo: useRuntimeConfig().demo })
})
