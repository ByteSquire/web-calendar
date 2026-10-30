import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { IcalFetchError } from './errors'

// The SSRF guard of the iCal proxy (design §4, §7). Users hand the server URLs to fetch, so the
// server must never be talked into reaching its own network: loopback, private ranges, the cloud
// metadata address and everything else that is not a public internet host.
//
// Two layers, both built on `isBlockedAddress`:
//   1. `resolveAllowed` resolves a host and rejects it when ANY resolved address is blocked.
//      Creating a subscription uses it for an immediate answer.
//   2. `createGuardedLookup` is the `lookup` option of the actual connection. The socket connects
//      to exactly the addresses this function hands back, so a DNS answer that changes between
//      the check and the connect (DNS rebinding) cannot help.
// Node skips `lookup` for IP literals, so those are checked before connecting (`isBlockedHost`).

export interface ResolvedAddress {
  address: string
  family: number
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

export interface AddressPolicy {
  resolve: Resolver
  isBlockedAddress: (address: string) => boolean
  isBlockedHostname: (hostname: string) => boolean
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

export function createAddressPolicy(options: {
  allowPrivate: boolean
  resolve?: Resolver
}): AddressPolicy {
  return {
    resolve: options.resolve ?? systemResolver,
    isBlockedAddress: options.allowPrivate ? () => false : isBlockedAddress,
    isBlockedHostname: options.allowPrivate ? () => false : isBlockedHostname,
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

/** The checks that need no DNS: IP literals (Node never calls `lookup` for them) and `localhost`. */
export function isBlockedHost(host: string, policy: AddressPolicy): boolean {
  return isIP(host) !== 0 ? policy.isBlockedAddress(host) : policy.isBlockedHostname(host)
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
  if (isBlockedHost(host, policy)) throw new IcalFetchError('blocked', 'blocked host')
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
  if (addresses.some((entry) => policy.isBlockedAddress(entry.address))) {
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
