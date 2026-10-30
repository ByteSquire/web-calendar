import { isIP } from 'node:net'

// The administrator's list of hosts the server may contact for its users (NUXT_OUTBOUND_ALLOWED_HOSTS,
// design §7). It is shared by the iCal subscriptions and the external CalDAV accounts. Why it exists:
// both features make this server send requests to an address a user chose, and a script injected
// into the page could use that to send what it stole (`https://attacker.example/<secret>`) to a host
// of its choosing. With a list, only the hosts the administrator named can be reached at all.
//
// Entries are comma-separated, case-insensitive, and of two kinds:
//   `cal.example.org`   exactly that host name (or a dotted IPv4 address)
//   `*.example.org`     every host below it, at any depth, but not `example.org` itself
// No scheme, port, path, user info or bare `*`; IDN names in their `xn--` form. Empty means "no
// list": any public host, as before. The same grammar is checked by server/validate-config.mjs
// (plain JS that runs before the server); tests/server/ical-host-list.test.ts feeds one table to both.

/** More than this is a copy-paste accident, not a policy. */
export const MAX_HOST_LIST_ENTRIES = 200
const MAX_HOSTNAME_LENGTH = 253
const MAX_LABEL_LENGTH = 63
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export interface HostList {
  /** Number of entries; a list of size 0 allows every public host. */
  readonly size: number
  /** `host` as `hostnameOf` writes it: lower case, no brackets, no trailing dot. */
  matches(host: string): boolean
}

export interface HostListParse {
  list: HostList
  /** One sentence per rejected entry, without the entry's neighbours. */
  problems: string[]
}

/** A host name or `*.` suffix reduced to a problem sentence, or null when it is acceptable. */
function nameProblem(name: string): string | null {
  if (name === '') return 'is empty'
  if (name.length > MAX_HOSTNAME_LENGTH) return 'is too long for a host name'
  if (/[^\x20-\x7e]/.test(name))
    return 'must be ASCII (write an international name in its xn-- form)'
  if (/\s/.test(name)) return 'must not contain blanks'
  if (name.includes('://')) return 'must be a host name, not a URL'
  if (/[:/?#@[\]\\]/.test(name)) return 'must be a bare host name (no port, path or user name)'
  if (name.includes('*')) return 'may use * only as the first label, written *.example.org'
  const labels = name.split('.')
  for (const label of labels) {
    if (label === '') return 'must not have an empty label (a leading, trailing or double dot)'
    if (label.length > MAX_LABEL_LENGTH) return 'has a label longer than 63 characters'
    if (!LABEL.test(label)) return 'has a label with characters other than letters, digits and -'
  }
  // The URL parser reads a host that ends in a number as an IPv4 address (`1.2.3` is 1.2.0.3).
  // Such an entry could never match what the guard compares it with, so only a plain dotted quad
  // passes.
  const last = labels[labels.length - 1]!
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(last)) {
    const quad =
      labels.length === 4 && isIP(name) === 4 && labels.every((l) => String(Number(l)) === l)
    if (!quad) return 'looks like an IP address but is not a dotted IPv4 address'
  }
  return null
}

function entryProblem(entry: string): { problem: string | null; suffix: boolean; name: string } {
  if (entry === '*') {
    return {
      problem: 'must not be a bare * (leave the list empty to allow every public host)',
      suffix: false,
      name: entry,
    }
  }
  if (entry.startsWith('*.')) {
    const name = entry.slice(2)
    let problem = nameProblem(name)
    // A suffix is a domain; an address (`*.1.2.3.4`) is not.
    if (problem === null && isIP(name) !== 0) problem = 'must not put * in front of an IP address'
    return { problem, suffix: true, name }
  }
  return { problem: nameProblem(entry), suffix: false, name: entry }
}

/**
 * Reads the setting. Never throws: the caller refuses to start when `problems` is not empty, and a
 * tolerant parse (dropping the bad entry) would leave a LONGER allowance than the administrator
 * wrote, so the list is only usable when `problems` is empty.
 */
export function parseHostList(text: string | null | undefined): HostListParse {
  const exact = new Set<string>()
  const suffixes = new Set<string>()
  const problems: string[] = []
  const trimmed = (text ?? '').trim()
  if (trimmed !== '') {
    const entries = trimmed.split(',').map((entry) => entry.trim().toLowerCase())
    if (entries.length > MAX_HOST_LIST_ENTRIES) {
      problems.push(`has more than ${MAX_HOST_LIST_ENTRIES} entries`)
    }
    for (const entry of entries.slice(0, MAX_HOST_LIST_ENTRIES)) {
      const { problem, suffix, name } = entryProblem(entry)
      if (problem !== null) {
        const shown = entry.length > 40 ? `${entry.slice(0, 40)}...` : entry
        problems.push(`the entry ${JSON.stringify(shown)} ${problem}`)
      } else if (suffix) {
        suffixes.add(name)
      } else {
        exact.add(name)
      }
    }
  }

  const list: HostList = {
    size: exact.size + suffixes.size,
    matches(host) {
      if (exact.has(host)) return true
      // `a.b.example.org` is checked against `b.example.org`, then `example.org`: never the host itself.
      for (let dot = host.indexOf('.'); dot !== -1; dot = host.indexOf('.', dot + 1)) {
        if (suffixes.has(host.slice(dot + 1))) return true
      }
      return false
    },
  }
  return { list, problems }
}
