import type { H3Event } from 'h3'
import { findExternalAccount } from '../../db/external-accounts'
import { getDb } from '../db'
import { getIcalPolicy, privateAddressesAllowed } from '../ical-proxy/nitro'
import type { AccountDeps } from './accounts'
import { createUserLimiter } from './limits'
import { createExternalProxy, REQUEST_TIMEOUT_MS, type ExternalProxy } from './proxy'
import { createSealer, parseSealKey, type Sealer } from './seal'

// Nitro glue of the external-account feature: reads the runtime config once, owns the one proxy
// instance (and with it the per-user limits) and adapts the Node request. The logic is in the plain
// modules next to this file.

let runtime: { sealer: Sealer | null; proxy: ExternalProxy } | undefined

function getRuntime() {
  if (!runtime) {
    // Empty means unset: Compose passes the variable on even when .env leaves it empty. A key that
    // is set but malformed stops the server (the message never contains the key).
    const key = String(useRuntimeConfig().external.sealKey).trim()
    const sealer = key === '' ? null : createSealer(parseSealKey(key))
    if (sealer === null) {
      console.info(
        '[external] NUXT_EXTERNAL_SEAL_KEY is not set: external accounts with a login are off',
      )
    }
    const proxy = createExternalProxy({
      policy: getIcalPolicy(),
      sealer,
      findAccount: (userId, accountId) => {
        const stored = findExternalAccount(getDb(), userId, accountId)
        return stored
          ? {
              id: stored.account.id,
              origin: stored.origin,
              authMode: stored.account.authMode,
              username: stored.account.username,
            }
          : null
      },
      limiter: createUserLimiter(),
      allowInsecureLogins: privateAddressesAllowed(),
    })
    runtime = { sealer, proxy }
  }
  return runtime
}

/** Builds the sealer and the proxy now; throws for a malformed key or host list. */
export function checkExternalConfig(): void {
  getRuntime()
}

/** What the account endpoints need besides the user: the database, the policy, the sealer. */
export function getAccountDeps(): AccountDeps {
  return {
    db: getDb(),
    policy: getIcalPolicy(),
    sealer: getRuntime().sealer,
    allowInsecureLogins: privateAddressesAllowed(),
  }
}

export function getSealer(): Sealer | null {
  return getRuntime().sealer
}

/**
 * Hands a request for `/api/external/<id>/...` to the proxy and returns its web `Response`. The
 * target is read from the raw request line: the router's parameter has lost the trailing slash that
 * every CalDAV collection path ends in, and the query. h3's body readers skip the body of PROPFIND
 * and REPORT, so the Node request is passed on as a stream.
 */
export function handleExternalRequest(
  event: H3Event,
  user: { id: number; sub: string },
): Promise<Response> {
  const handle = getRuntime().proxy
  const { req, res } = event.node
  const match = /^\/api\/external\/([^/?#]*)(.*)$/s.exec(req.url ?? '')
  const hasBody =
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0
  const abort = new AbortController()
  res.once('close', () => {
    if (!res.writableFinished) abort.abort()
  })
  return handle({
    user,
    accountId: match?.[1] ?? '',
    method: req.method ?? 'GET',
    target: match?.[2] ?? '',
    headers: event.headers,
    body: hasBody ? req : null,
    signal: abort.signal,
    afterSent(callback) {
      if (res.destroyed || res.writableFinished) return callback()
      res.once('close', callback)
      // A client that stops reading must not keep the buffered answer for ever.
      res.setTimeout(REQUEST_TIMEOUT_MS, () => res.destroy())
    },
  })
}
