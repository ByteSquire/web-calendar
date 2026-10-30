import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { IcalFetchError } from './errors'
import type { HostList } from './host-list'

// The SSRF guard of the iCal proxy and the external-account proxy (design §4, §7). Users hand the
// server URLs to fetch, so the server must never be talked into reaching its own network: loopback,
// private ranges, the cloud metadata address and everything else that is not a public internet host.
//
// Two layers, both built on `isBlockedAddress`:
//   1. `resolveAllowed` resolves a host and rejects it when ANY resolved address is blocked.
//      Creating a subscription or an account uses it for an immediate answer.
//   2. `createGuardedLookup` is the `lookup` option of the actual connection. The socket connects
//      to exactly the addresses this function hands back, so a DNS answer that changes between
//      the check and the connect (DNS rebinding) cannot help.
// Node skips `lookup` for IP literals, so those are checked before connecting (`isBlockedHost`).
//
// The administrator's host list (NUXT_OUTBOUND_ALLOWED_HOSTS, host-list.ts) is part of the same
// policy, so it is enforced at the same three places. When it is set, a host that is not on it is
// refused, and a host that is on it may live in a private range (an internal server needs an
// entry) but never in loopback, link-local, unspecified or multicast space. The host of the CalDAV
// store (`refusedHosts`) is refused even if listed.

export interface ResolvedAddress {
  address: string
  family: number
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

export interface AddressPolicy {
  resolve: Resolver
  /** `hostname` is the host the address was found for, when there is one (see the host list). */
  isBlockedAddress: (address: string, hostname?: string) => boolean
  isBlockedHostname: (hostname: string) => boolean
  /** True when a host list is set and does not name this host. Absent: there is no list. */
  isUnlistedHostname?: (hostname: string) => boolean
}

// Every IPv4 range that is not a public unicast address: [base, prefix length].
const BLOCKED_IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network", includes 0.0.0.0
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes the broadcast address 255.255.255.255
]

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return bytes.every((byte) => byte <= 255) ? bytes : null
}

function ipv4ToInt(bytes: number[]): number {
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
}

const BLOCKED_IPV4_MASKED = BLOCKED_IPV4.map(([base, prefix]) => {
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return { network: (ipv4ToInt(parseIPv4(base)!) & mask) >>> 0, mask }
})

function isBlockedIPv4(address: string): boolean {
  const bytes = parseIPv4(address)
  if (!bytes) return true
  const value = ipv4ToInt(bytes)
  return BLOCKED_IPV4_MASKED.some(({ network, mask }) => (value & mask) >>> 0 === network)
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, an IPv4 tail converted). */
function parseIPv6(address: string): number[] | null {
  let text = address
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const v4 = parseIPv4(tail[1]!)
    if (!v4) return null
    text = `${text.slice(0, -tail[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${(
      (v4[2]! << 8) |
      v4[3]!
    ).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null
  return groups.map((group) => parseInt(group, 16))
}

function isBlockedIPv6(address: string): boolean {
  const groups = parseIPv6(address)
  if (!groups) return true
  const [first, second] = [groups[0]!, groups[1]!]
  // Only global unicast, 2000::/3, can be a public host. This drops in one rule: :: and ::1,
  // IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96) addresses in any notation, NAT64
  // (64:ff9b::/96), fc00::/7, fe80::/10, fec0::/10 and ff00::/8.
  if ((first & 0xe000) !== 0x2000) return true
  if (first === 0x2001 && second < 0x0200) return true // 2001::/23 protocol assignments, Teredo
  if (first === 0x2001 && second === 0x0db8) return true // documentation
  if (first === 0x2002) return true // 6to4 tunnels to any IPv4 address
  if (first === 0x3fff && second < 0x1000) return true // documentation, 3fff::/20
  return false
}

/** True for anything that is not a public unicast address. Unparsable input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  // A scope id (`fe80::1%eth0`) does not change which address it is.
  const bare = address.split('%')[0]!
  const family = isIP(bare)
  if (family === 4) return isBlockedIPv4(bare)
  if (family === 6) return isBlockedIPv6(bare)
  return true
}

/** `localhost` and `*.localhost` mean the machine itself (RFC 6761), whatever a resolver says. */
export function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

export const systemResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true })

// What stays blocked for a host the administrator listed: [base, prefix length]. Everything else
// that `isBlockedAddress` blocks (RFC 1918, carrier-grade NAT, unique local addresses) is allowed
// for such a host, because that is where internal servers live.
const HARD_BLOCKED_IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // unspecified, "this network"
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes the cloud metadata address 169.254.169.254
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes the broadcast address
]

const HARD_BLOCKED_IPV4_MASKED = HARD_BLOCKED_IPV4.map(([base, prefix]) => {
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return { network: (ipv4ToInt(parseIPv4(base)!) & mask) >>> 0, mask }
})

/**
 * The address check for a host on the administrator's list. IPv4: everything but the ranges above.
 * IPv6: what `isBlockedAddress` allows, plus unique local addresses (fc00::/7); loopback,
 * unspecified, link-local, multicast and every IPv4-mapped, -compatible, NAT64 and 6to4 form stay
 * blocked, so a listed name cannot be pointed at `::ffff:169.254.169.254`.
 */
export function isBlockedForListedHost(address: string): boolean {
  const bare = address.split('%')[0]!
  const family = isIP(bare)
  if (family === 4) {
    const value = ipv4ToInt(parseIPv4(bare)!)
    return HARD_BLOCKED_IPV4_MASKED.some(({ network, mask }) => (value & mask) >>> 0 === network)
  }
  if (family === 6) {
    const groups = parseIPv6(bare)
    if (!groups) return true
    return (groups[0]! & 0xfe00) !== 0xfc00 && isBlockedIPv6(bare)
  }
  return true
}

/** One spelling per address, so that `::1` and `0:0:0:0:0:0:0:1` are the same entry of a set. */
function canonicalAddress(address: string): string {
  const bare = address.split('%')[0]!.toLowerCase()
  if (isIP(bare) !== 6) return bare
  try {
    return new URL(`http://[${bare}]/`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return bare
  }
}

export function createAddressPolicy(options: {
  allowPrivate: boolean
  resolve?: Resolver
  /** NUXT_OUTBOUND_ALLOWED_HOSTS; null or an empty list allows every public host. */
  allowedHosts?: HostList | null
  /**
   * Hosts that are never contacted, listed or not: the CalDAV store, which trusts `X-Remote-User`.
   * Host names are compared by name, an IP address also by the address a host resolves to.
   */
  refusedHosts?: readonly string[]
}): AddressPolicy {
  const list = options.allowedHosts && options.allowedHosts.size > 0 ? options.allowedHosts : null
  const refusedNames = new Set<string>()
  const refusedAddresses = new Set<string>()
  for (const host of options.refusedHosts ?? []) {
    const name = host
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase()
    if (isIP(name) !== 0) refusedAddresses.add(canonicalAddress(name))
    else refusedNames.add(name)
  }

  // The switch for tests and local development turns the address rules and the refusals off, but
  // not the list: that is the administrator's decision, not an SSRF rule.
  return {
    resolve: options.resolve ?? systemResolver,
    isBlockedAddress: options.allowPrivate
      ? () => false
      : (address, hostname) => {
          if (refusedAddresses.has(canonicalAddress(address))) return true
          if (list && hostname !== undefined && list.matches(hostname)) {
            return isBlockedForListedHost(address)
          }
          return isBlockedAddress(address)
        },
    isBlockedHostname: options.allowPrivate
      ? () => false
      : (hostname) => isBlockedHostname(hostname) || refusedNames.has(hostname),
    isUnlistedHostname: list ? (hostname) => !list.matches(hostname) : undefined,
  }
}

/**
 * The host of a URL as the guard compares it: lower case, no IPv6 brackets, no trailing dot. The
 * WHATWG URL parser has already turned decimal, octal and hex IPv4 forms into dotted quads.
 */
export function hostnameOf(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

/**
 * The checks that need no DNS: the host list, IP literals (Node never calls `lookup` for them) and
 * `localhost`.
 */
export function isBlockedHost(host: string, policy: AddressPolicy): boolean {
  if (policy.isUnlistedHostname?.(host)) return true
  return isIP(host) !== 0 ? policy.isBlockedAddress(host, host) : policy.isBlockedHostname(host)
}

/**
 * The error for a host the policy refuses without DNS, or null. Its reason is `blocked`; `notListed`
 * tells a host that is not on the administrator's list from one with a forbidden address.
 */
export function hostRefusal(host: string, policy: AddressPolicy): IcalFetchError | null {
  if (policy.isUnlistedHostname?.(host)) {
    return new IcalFetchError('blocked', 'host is not on the list of allowed hosts', {
      notListed: true,
    })
  }
  return isBlockedHost(host, policy) ? new IcalFetchError('blocked', 'blocked host') : null
}

/**
 * Resolves the host and returns its addresses. Throws `IcalFetchError('blocked')` when the host,
 * or any ONE of its addresses, is blocked (a name with a public and a private record is an
 * attack, not a mixed blessing), and `'unreachable'` when it does not resolve.
 */
export async function resolveAllowed(
  host: string,
  policy: AddressPolicy,
): Promise<ResolvedAddress[]> {
  const refusal = hostRefusal(host, policy)
  if (refusal) throw refusal
  const family = isIP(host)
  if (family !== 0) return [{ address: host, family }]

  let addresses: ResolvedAddress[]
  try {
    addresses = await policy.resolve(host)
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code
    throw new IcalFetchError('unreachable', `cannot resolve the host${code ? ` (${code})` : ''}`, {
      cause,
    })
  }
  if (addresses.length === 0) throw new IcalFetchError('unreachable', 'the host has no addresses')
  if (addresses.some((entry) => policy.isBlockedAddress(entry.address, host))) {
    throw new IcalFetchError('blocked', 'the host resolves to a blocked address')
  }
  return addresses
}

/**
 * The `lookup` option for `http.request` / `https.request`. Node 20+ calls it with `all: true`
 * (happy eyeballs); `all: false` is handled as well. A rejected host is reported through
 * `onReject` and as the callback error, so the caller can tell a policy refusal from a network
 * failure however Node wraps the error on its way out.
 */
export function createGuardedLookup(
  policy: AddressPolicy,
  onReject?: (error: IcalFetchError) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    resolveAllowed(hostname.replace(/\.$/, '').toLowerCase(), policy).then(
      (addresses) => {
        const family = Number(options.family)
        const wanted =
          family === 4 || family === 6
            ? addresses.filter((entry) => entry.family === family)
            : addresses
        if (wanted.length === 0) {
          const error: NodeJS.ErrnoException = new Error(`no IPv${family} address for the host`)
          error.code = 'ENOTFOUND'
          callback(error, [])
        } else if (options.all) {
          callback(null, wanted)
        } else {
          callback(null, wanted[0]!.address, wanted[0]!.family)
        }
      },
      (error: unknown) => {
        const failure =
          error instanceof IcalFetchError
            ? error
            : new IcalFetchError('unreachable', 'cannot resolve the host', { cause: error })
        onReject?.(failure)
        callback(failure, [])
      },
    )
  }
}
