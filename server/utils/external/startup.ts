import { runStartupChecks } from '../api/startup-checks'
import { getIcalPolicy } from '../ical-proxy/nitro'
import { checkExternalConfig } from './nitro'

// Builds the parts of the external-account feature that read the environment now, like
// server/utils/api/startup.ts does for the rest (L2): a malformed NUXT_EXTERNAL_SEAL_KEY or
// NUXT_OUTBOUND_ALLOWED_HOSTS stops the server at start with a readable message instead of a 500 on
// the first request. Requests wait for the checks.

/** The part of Nitro's hooks this module uses. */
export interface ExternalStartupHooks {
  hook(name: 'request', handler: () => Promise<void>): unknown
}

export function installExternalStartupChecks(hooks: ExternalStartupHooks): void {
  async function start(): Promise<void> {
    const failures = await runStartupChecks([
      { name: 'outbound host list (NUXT_OUTBOUND_ALLOWED_HOSTS)', run: () => getIcalPolicy() },
      { name: 'external accounts (NUXT_EXTERNAL_SEAL_KEY)', run: () => checkExternalConfig() },
    ])
    if (failures.length > 0) {
      throw new Error(failures.map((failure) => `\n  - ${failure}`).join(''))
    }
  }

  const ready = start().catch((error: unknown) => {
    console.error(
      `[startup] The server cannot start with this configuration:${error instanceof Error ? error.message : String(error)}\n` +
        '[startup] Fix the NUXT_* environment variables (see .env.example) and start again.',
    )
    process.exit(1)
  })
  hooks.hook('request', () => ready)
}
