// The one userinfo client of the process, so the kept answers and the shared calls are shared by
// every request (GET /api/me and the admin check).
import { processDiscoveryStore } from '../auth/discovery'
import { createUserinfoClient, type UserinfoClient } from './userinfo-client'

let client: UserinfoClient | undefined

export function getUserinfoClient(): UserinfoClient {
  // `globalThis.fetch` is looked up per call so a test can replace it.
  client ??= createUserinfoClient({
    fetch: (input, init) => globalThis.fetch(input, init),
    // The token verifier keeps the discovery documents; a token was verified, so its issuer's is
    // there. Without one the answer is `no-endpoint` and the caller falls back, never a guess.
    endpointOf: (issuer) => processDiscoveryStore().current(issuer)?.userinfoEndpoint ?? null,
  })
  return client
}
