import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IcalFetchError } from './errors'
import { createGuardedLookup, hostnameOf, type AddressPolicy } from './ssrf'

// The one place a request to a user-chosen address is opened (iCal fetcher, external-account proxy).
// Node's `fetch` cannot pin the address it connects to, so this uses `node:http(s)` with the guarded
// `lookup` of ssrf.ts: the socket connects to exactly the addresses the policy approved.

export interface GuardedRequestInit {
  method: string
  headers: Record<string, string>
  policy: AddressPolicy
  /** Called with the policy's refusal, so a caller can tell it from a network failure. */
  onReject: (error: IcalFetchError) => void
  /** The request target when it is not `url.pathname + url.search` (the raw, already checked one). */
  path?: string
}

export function openGuardedRequest(url: URL, init: GuardedRequestInit): ClientRequest {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return send({
    // The normalised host: `new URL` has turned odd IPv4 notations into dotted quads.
    hostname: hostnameOf(url),
    port: url.port === '' ? undefined : Number(url.port),
    path: init.path ?? `${url.pathname}${url.search}`,
    method: init.method,
    headers: init.headers,
    // A fresh connection per request, never a pooled socket that skipped the guard. TLS
    // certificates are verified (the default).
    agent: false,
    lookup: createGuardedLookup(init.policy, init.onReject),
  })
}
