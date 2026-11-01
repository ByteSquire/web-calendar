import type { Database } from 'better-sqlite3'
import { recordAudit } from '../../db/audit-log'
import type { CalendarRow } from '../../db/types'
import { listAllCalendarAcl } from '../../db/calendar-acl'
import { isValidSubject } from '../auth/subject'
import { parseHomeListing } from './calendars'
import { computeDesiredShares, type DesiredShare } from './desired'
import type { GroupMembership } from './membership'
import { isShareName } from './names'
import { isActingPrincipal, type RadicaleClient } from './radicale-client'
import { SHARING_ACTOR, type SharingLogger, type SharingResult } from './types'

// The nightly second opinion (security review §7.1): list each home as each user and compare the
// shared collections with what calendar_acl says that user may see. It does not trust the
// reconcile's own bookkeeping: it looks at what each user actually gets.

export interface AuditJobOptions {
  db: Database
  client: RadicaleClient
  membership: GroupMembership
  log: SharingLogger
  withAvailability?: boolean
}

export interface AuditJobSummary {
  usersChecked: number
  differences: string[]
}

const MAX_LISTED_DIFFERENCES = 20

function lastSegment(path: string): string {
  return (
    path
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? ''
  )
}

export function createConsistencyAudit(options: AuditJobOptions) {
  const { db, client, membership, log } = options
  let lastSignature = ''

  async function execute(): Promise<SharingResult<AuditJobSummary>> {
    const calendars = new Map(
      db
        .prepare<[], CalendarRow>('SELECT * FROM calendars')
        .all()
        .map((row) => [row.id, row]),
    )
    const rows = listAllCalendarAcl(db)
    const desired = computeDesiredShares(rows, calendars, {
      withAvailability: options.withAvailability ?? true,
    })
    // A share counts as due only when every rule behind it is confirmed; a pending change is the
    // reconcile's business, not a difference.
    const pending = new Set<string>()
    for (const row of rows) {
      const status = desired.rows.get(row.id)
      if (row.applied_at === null && status?.kind === 'share') pending.add(status.key)
    }
    const groupsOfAll = await membership.all()
    const users = db
      .prepare<[], { oidc_sub: string }>('SELECT oidc_sub FROM users ORDER BY id')
      .all()
      .map((user) => user.oidc_sub)
      .filter((sub) => isValidSubject(sub) && isActingPrincipal(sub))

    const differences: string[] = []
    for (const sub of users) {
      const groups = groupsOfAll.get(sub.toLowerCase()) ?? new Set<string>()
      const mine = desired.shares.filter(
        (share: DesiredShare) =>
          share.owner !== sub &&
          (share.kind === 'user' ? share.user === sub : groups.has(share.user.slice(1))),
      )
      const expected = new Set(mine.map((share) => lastSegment(share.pathOrToken)))
      const due = new Set(
        mine
          .filter(
            (share) => !pending.has(`${share.owner}\u0000${share.pathMapped}\u0000${share.user}`),
          )
          .map((share) => lastSegment(share.pathOrToken)),
      )
      const listing = await client.propfind(sub, `/${encodeURIComponent(sub)}/`, 1)
      if (!listing.ok) {
        if (listing.failure.kind === 'unreachable') return listing
        // No home yet: nothing is visible to this user.
        if (listing.failure.status !== 404) {
          differences.push(`cannot list the home of ${sub}: ${listing.failure.message}`)
          continue
        }
        for (const name of due) differences.push(`${sub} lacks ${name}`)
        continue
      }
      const actual = new Set(
        parseHomeListing(listing.value, sub)
          .map((calendar) => calendar.name)
          .filter(isShareName),
      )
      for (const name of actual) {
        if (!expected.has(name)) differences.push(`${sub} sees ${name} without a rule`)
      }
      for (const name of due) {
        if (!actual.has(name)) differences.push(`${sub} lacks ${name}`)
      }
    }
    return { ok: true, value: { usersChecked: users.length, differences: differences.sort() } }
  }

  return {
    async run(): Promise<SharingResult<AuditJobSummary>> {
      const result = await execute()
      if (!result.ok) {
        log.warn(`[sharing] the consistency audit could not run: ${result.failure.message}`)
        return result
      }
      const { differences } = result.value
      const signature = differences.join('\n')
      if (differences.length === 0) {
        lastSignature = ''
        return result
      }
      log.error(
        `[sharing] consistency audit: ${differences.length} difference(s): ${differences.slice(0, 5).join('; ')}`,
      )
      if (signature !== lastSignature) {
        lastSignature = signature
        try {
          recordAudit(db, {
            actorSub: SHARING_ACTOR,
            action: 'sharing.audit_mismatch',
            target: 'consistency-audit',
            details: {
              count: differences.length,
              differences: differences.slice(0, MAX_LISTED_DIFFERENCES),
            },
          })
        } catch (error) {
          log.error(`[sharing] the audit entry could not be written: ${String(error)}`)
        }
      }
      return result
    },
  }
}
