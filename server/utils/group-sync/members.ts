// Maps the member SPNs Kanidm lists (`alice@idm.example.org`) to the `sub` UUIDs the group file
// needs. The sync token cannot read persons (a read of one answers `null`), so the only source is
// the app's own `users` table: Kanidm's `preferred_username` claim is the SPN, and `oidc_sub` is
// the UUID. Nothing is cached across runs: an SPN can be released and given to another person, and
// a stale entry would then grant that person the old one's access.
//
// With `prefer-short-username` on the OIDC client (the documented setup) `preferred_username` is the
// short name, `alice`, while Kanidm still lists the member as `alice@idm.example.org`. A short name
// is matched too, but only when the SPN's domain is the Kanidm domain: the host of the issuer is
// that domain or a subdomain of it. Names are unique within one Kanidm domain, so `alice` there is
// `alice@<that domain>`; an `alice@elsewhere.example` is somebody else and never matches.
import type { Database } from 'better-sqlite3'
import { fail, type Result } from './types'

export type MemberResolver = (spns: string[]) => Result<Map<string, string>>

export interface UsersTableResolverOptions {
  /**
   * `NUXT_OIDC_ISSUER`. Its host names the Kanidm domain for the short-name match. Absent or not a
   * URL: only a user whose name is the whole SPN matches.
   */
  issuer?: string
}

/** The lower-case host of the issuer, or null when it is not a URL. */
function hostOf(issuer: string | undefined): string | null {
  if (!issuer) return null
  try {
    return new URL(issuer).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** True when `domain` is `host` or a parent domain of it (Kanidm's origin lies within its domain). */
function domainCovers(domain: string, host: string): boolean {
  return domain === host || host.endsWith(`.${domain}`)
}

/**
 * The short name of a member whose SPN is in the Kanidm domain, else null. Exactly one `@` is
 * allowed, with something on both sides.
 */
function shortNameOf(spn: string, issuerHost: string | null): string | null {
  if (issuerHost === null) return null
  const at = spn.indexOf('@')
  if (at <= 0 || at !== spn.lastIndexOf('@') || at === spn.length - 1) return null
  const domain = spn.slice(at + 1).toLowerCase()
  return domainCovers(domain, issuerHost) ? spn.slice(0, at) : null
}

export function createUsersTableResolver(
  db: Database,
  options: UsersTableResolverOptions = {},
): MemberResolver {
  const issuerHost = hostOf(options.issuer)
  const find = db.prepare<[string], { oidc_sub: string }>(
    'SELECT oidc_sub FROM users WHERE username = ? COLLATE NOCASE',
  )
  return (spns) => {
    const resolved = new Map<string, string>()
    const missing: string[] = []
    for (const spn of spns) {
      // The name is unique in the table (a case-insensitive unique index), so a match is one user.
      const short = shortNameOf(spn, issuerHost)
      const row = find.get(spn) ?? (short === null ? undefined : find.get(short))
      if (row) resolved.set(spn, row.oidc_sub)
      else missing.push(spn)
    }
    if (missing.length > 0) {
      const shown = missing.slice(0, 5).join(', ')
      const more = missing.length > 5 ? ` and ${missing.length - 5} more` : ''
      return fail(
        'unresolved-members',
        `${missing.length} group member(s) have no known UUID yet (they have not signed in): ${shown}${more}`,
      )
    }
    return { ok: true, value: resolved }
  }
}
