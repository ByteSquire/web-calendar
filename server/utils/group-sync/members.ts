// Maps the member SPNs Kanidm lists (`alice@idm.example.org`) to the `sub` UUIDs the group file
// needs. The sync token cannot read persons (a read of one answers `null`), so the only source is
// the app's own `users` table: Kanidm's `preferred_username` claim is the SPN, and `oidc_sub` is
// the UUID. Nothing is cached across runs: an SPN can be released and given to another person, and
// a stale entry would then grant that person the old one's access.
import type { Database } from 'better-sqlite3'
import { fail, type Result } from './types'

export type MemberResolver = (spns: string[]) => Result<Map<string, string>>

export function createUsersTableResolver(db: Database): MemberResolver {
  const find = db.prepare<[string], { oidc_sub: string }>(
    'SELECT oidc_sub FROM users WHERE username = ? COLLATE NOCASE',
  )
  return (spns) => {
    const resolved = new Map<string, string>()
    const missing: string[] = []
    for (const spn of spns) {
      const row = find.get(spn)
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
