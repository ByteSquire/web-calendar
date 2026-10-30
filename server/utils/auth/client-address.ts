import { isIP } from 'node:net'

// Client addresses as the Basic-login throttle sees them: one spelling per address, and the one hop
// of `X-Forwarded-For` that can be trusted.

/** The key of a request whose address is missing or not an IP address; all such clients share it. */
export const UNKNOWN_ADDRESS = 'unknown'

function withoutZone(address: string): string {
  const zone = address.indexOf('%')
  return zone === -1 ? address : address.slice(0, zone)
}

/**
 * One spelling per address, so a client cannot dodge a counter by writing its address differently:
 * IPv6 is compressed and lower-cased, an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, which is how a
 * dual-stack socket reports an IPv4 client) becomes the IPv4 address, a zone id (`%eth0`) is dropped.
 * Anything that is not an IP address maps to {@link UNKNOWN_ADDRESS}. Each IPv6 address is its own
 * client; a client with a whole /64 can therefore rotate (grouping by prefix would be stricter, and
 * would make a shared /64, such as an office LAN, one client).
 */
export function normalizeClientAddress(address: string | null | undefined): string {
  if (!address) return UNKNOWN_ADDRESS
  const bare = withoutZone(address.trim())
  const version = isIP(bare)
  if (version === 4) return bare
  if (version !== 6) return UNKNOWN_ADDRESS
  let canonical: string
  try {
    canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1)
  } catch {
    return UNKNOWN_ADDRESS
  }
  // The URL parser writes the mapped form with hex groups: ::ffff:102:304 is 1.2.3.4.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (mapped) {
    const high = parseInt(mapped[1]!, 16)
    const low = parseInt(mapped[2]!, 16)
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  }
  return canonical
}

/**
 * The address a reverse proxy appended to `X-Forwarded-For`: the LAST entry, or null when it is not
 * a plain IP address (the caller then falls back to the socket address).
 *
 * Why not h3's `getRequestIP(event, { xForwardedFor: true })`: it returns the FIRST entry, which is
 * whatever the client wrote when the proxy appends to the header (nginx's `$proxy_add_x_forwarded_for`,
 * the default of most proxies), so every request could pick its own address. The last entry is the
 * one our own proxy added. This is only sound when the proxy in front of the app is the only thing
 * that can reach it and it writes the header (appending, or overwriting it with the peer address);
 * `gateway.trustForwardedFor` must stay off otherwise, or any client can name its own address. With
 * more than one proxy in a chain the last entry is the inner proxy's address: all clients then share
 * one counter, which is coarser but never weaker.
 *
 * `Headers.get` already joins repeated `X-Forwarded-For` lines with a comma, in order.
 */
export function lastForwardedHop(header: string | null | undefined): string | null {
  if (!header) return null
  const last = header.slice(header.lastIndexOf(',') + 1).trim()
  return isIP(withoutZone(last)) === 0 ? null : last
}

/**
 * True for the addresses a reverse proxy in front of the app normally has: loopback, private
 * (RFC 1918, unique local), link-local and the shared 100.64.0.0/10 range. Requests that arrive from
 * one of them probably carry other clients' traffic, so the address says nothing about the client.
 */
export function looksLikeProxyAddress(address: string | null | undefined): boolean {
  const normalized = normalizeClientAddress(address)
  const version = isIP(normalized)
  if (version === 4) {
    const [first, second] = normalized.split('.').map(Number) as [number, number]
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254) ||
      (first === 100 && second >= 64 && second <= 127)
    )
  }
  if (version === 6) {
    if (normalized === '::1') return true
    // The canonical form starts with the first group, or with "::" when that group is zero.
    const first = parseInt(normalized.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  return false
}

/**
 * The warning for the log when requests arrive from a proxy-like address and `trustForwardedFor` is
 * off, otherwise null. All clients then share one address as far as the login throttle can tell.
 * A correct login is never refused for that, but the failure rate and the per-user counts are shared
 * by everybody behind the proxy.
 */
export function sharedAddressWarning(
  peer: string | null | undefined,
  trustForwardedFor: boolean,
): string | null {
  if (trustForwardedFor || !looksLikeProxyAddress(peer)) return null
  return (
    `requests arrive from ${normalizeClientAddress(peer)}, which looks like a reverse proxy: all ` +
    'clients share this one address for the throttle of failed Basic logins. Behind a trusted proxy ' +
    'that writes X-Forwarded-For, set NUXT_GATEWAY_TRUST_FORWARDED_FOR=true.'
  )
}
