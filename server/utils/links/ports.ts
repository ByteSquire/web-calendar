// The process-wide parts of the calendar links: the reader (Radicale as the maker) and the limits of
// the public routes. Tests set their own reader.
import type { H3Event } from 'h3'
import { getRequestIP } from 'h3'
import { createAdminLimiter, type AdminLimiter } from '../api/admin-limit'
import { clientGroupKey, lastForwardedHop } from '../auth/client-address'
import { createLinkReader, type LinkReader } from './reader'

let reader: LinkReader | undefined

/** A year of a busy shared calendar, expanded, is more than the 4 MiB of the booking reader. */
const LINK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export function getLinkReader(): LinkReader {
  reader ??= createLinkReader({
    baseUrl: useRuntimeConfig().radicale.url,
    maxResponseBytes: LINK_MAX_RESPONSE_BYTES,
  })
  return reader
}

export function setLinkReader(next: LinkReader | undefined): void {
  reader = next
}

/**
 * The limits of the public routes, each a token bucket. The two of the password count wrong
 * passwords only (a right one takes nothing), and refuse every try once they are used up.
 */
export interface LinkLimits {
  /** Wrong passwords per client address: 10 at once, then one every 10 seconds. */
  attemptsPerAddress: AdminLimiter
  /** Wrong passwords per link from anywhere: 30 at once, then one every 10 seconds. */
  attemptsPerLink: AdminLimiter
  /** Reads per client address: 120 at once, then 4 a second. */
  readsPerAddress: AdminLimiter
}

let limits: LinkLimits | undefined

export function getLinkLimits(): LinkLimits {
  limits ??= {
    attemptsPerAddress: createAdminLimiter({ burst: 10, refillPerSec: 0.1 }),
    attemptsPerLink: createAdminLimiter({ burst: 30, refillPerSec: 0.1 }),
    readsPerAddress: createAdminLimiter({ burst: 120, refillPerSec: 4 }),
  }
  return limits
}

export function resetLinkLimits(next?: LinkLimits): void {
  limits = next
}

/**
 * The client as the limits count it: the socket's peer, or, with NUXT_GATEWAY_TRUST_FORWARDED_FOR,
 * the address the reverse proxy appended (the same rule as the throttle of the CalDAV gateway). An
 * IPv6 client counts by its /64.
 */
export function linkClientKey(event: H3Event): string {
  const trust = String(useRuntimeConfig().gateway.trustForwardedFor) === 'true'
  const hop = trust ? lastForwardedHop(event.headers.get('x-forwarded-for')) : null
  return clientGroupKey(hop ?? getRequestIP(event) ?? null)
}
