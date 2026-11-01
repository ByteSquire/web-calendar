import type { Database } from 'better-sqlite3'
import { recordAudit } from '../../db/audit-log'
import { listAllCalendarAcl, markCalendarAclApplied } from '../../db/calendar-acl'
import type { CalendarAclRow, CalendarRow } from '../../db/types'
import { isValidSubject } from '../auth/subject'
import { ensureAvailabilityCollection } from './block-store'
import { discoverCalendars } from './calendars'
import {
  actualKey,
  availabilityShare,
  computeDesiredShares,
  desiredKey,
  sameShare,
  type DesiredShare,
} from './desired'
import { splitCollectionPath } from './names'
import { isActingPrincipal, type RadicaleClient } from './radicale-client'
import {
  RESOURCES_PRINCIPAL,
  SHARING_ACTOR,
  sharingFail,
  type SharingLogger,
  type RadicaleShare,
  type SharingResult,
  type SharingFailure,
} from './types'

// Reconcile, do not patch (security review §7.1): desired shares from calendar_acl, Radicale's
// actual list per owner, apply the difference, read again, compare, alarm on any difference.

export interface ReconcileOptions {
  db: Database
  client: RadicaleClient
  log: SharingLogger
  /** Service principals whose calendars are mirrored as `shared`. */
  sharedOwners?: readonly string[]
  now?: () => Date
  /** Whether to keep `/_resources/availability/` shared with `f`. Default true. */
  withAvailability?: boolean
}

export interface ReconcileSummary {
  created: number
  updated: number
  removed: number
  /** Rules marked applied in this run. */
  applied: number
  /** Rules still waiting for Radicale. */
  unapplied: number
  /** Differences found by the verification (empty when Radicale matches SQLite). */
  differences: string[]
}

export interface ReconcileState {
  lastRunAt: string | null
  lastSuccessAt: string | null
  consecutiveFailures: number
  lastFailure: string | null
  lastSummary: ReconcileSummary | null
}

export interface SharingReconciler {
  run(): Promise<SharingResult<ReconcileSummary>>
  state(): ReconcileState
}

/** Failures in a row after which the error log and the audit log say it is not a blip. */
export const SHARING_ESCALATE_AFTER_FAILURES = 5
const MAX_LISTED_DIFFERENCES = 20

interface OwnerPlan {
  deletes: { share: RadicaleShare; type: 'map' | 'token'; reason: 'unknown' | 'changed' }[]
  creates: DesiredShare[]
  /** Existing user shares the member still has to accept. */
  reaccept: DesiredShare[]
}

/** Pure: what must change at one owner so that `actual` equals `desired`. */
export function planOwner(
  owner: string,
  desired: readonly DesiredShare[],
  actual: readonly RadicaleShare[],
  tokens: readonly RadicaleShare[] = [],
): OwnerPlan {
  const wanted = new Map(desired.map((share) => [desiredKey(share), share]))
  const plan: OwnerPlan = { deletes: [], creates: [], reaccept: [] }
  const present = new Set<string>()
  for (const share of actual) {
    const key = actualKey(owner, share)
    const match = wanted.get(key)
    if (!match) {
      plan.deletes.push({ share, type: 'map', reason: 'unknown' })
    } else if (!sameShare(match, share) || (match.kind === 'group' && !share.enabled)) {
      plan.deletes.push({ share, type: 'map', reason: 'changed' })
    } else {
      present.add(key)
      if (match.kind === 'user' && (!share.enabled || share.hidden)) plan.reaccept.push(match)
    }
  }
  for (const share of tokens) plan.deletes.push({ share, type: 'token', reason: 'unknown' })
  for (const [key, share] of wanted) if (!present.has(key)) plan.creates.push(share)
  return plan
}

function describe(owner: string, share: { pathMapped: string; user: string }): string {
  return `${owner} ${share.pathMapped} -> ${share.user}`
}

interface CalendarRows {
  rows: CalendarAclRow[]
  calendars: Map<number, CalendarRow>
}

function loadRules(db: Database): CalendarRows {
  const calendars = new Map(
    db
      .prepare<[], CalendarRow>('SELECT * FROM calendars ORDER BY id')
      .all()
      .map((row) => [row.id, row]),
  )
  return { rows: listAllCalendarAcl(db), calendars }
}

export function createSharingReconciler(options: ReconcileOptions): SharingReconciler {
  const { db, client, log } = options
  const now = options.now ?? (() => new Date())
  const sharedOwners = options.sharedOwners ?? []
  const withAvailability = options.withAvailability ?? true
  const state: ReconcileState = {
    lastRunAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    lastFailure: null,
    lastSummary: null,
  }
  let lastAlarmSignature = ''
  let escalated = false

  function audit(action: string, target: string, details: Record<string, unknown>): void {
    try {
      recordAudit(db, { actorSub: SHARING_ACTOR, action, target, details })
    } catch (error) {
      log.error(`[sharing] the audit entry ${action} could not be written: ${String(error)}`)
    }
  }

  function noteFailure(failure: SharingFailure): void {
    state.consecutiveFailures += 1
    state.lastFailure = failure.message
    log.warn(`[sharing] reconcile failed (${failure.kind}): ${failure.message}`)
    if (state.consecutiveFailures >= SHARING_ESCALATE_AFTER_FAILURES && !escalated) {
      escalated = true
      log.error(
        `[sharing] ${state.consecutiveFailures} reconciles in a row failed; access rules are not applied`,
      )
      audit('sharing.failing', 'reconcile', {
        failures: state.consecutiveFailures,
        kind: failure.kind,
      })
    }
  }

  async function execute(): Promise<SharingResult<ReconcileSummary>> {
    const discovery = await discoverCalendars(db, client, sharedOwners)
    if (!discovery.ok) return discovery
    const { listedOwners, existing } = discovery.value

    const { rows, calendars } = loadRules(db)
    const desired = computeDesiredShares(rows, calendars, { withAvailability })
    const differences: string[] = [...desired.invalid]
    const failedShares = new Set<string>()

    // Calendars gone from Radicale get no share; their rules wait (and their old shares go).
    const gone = new Set<number>()
    const listed = new Set(listedOwners)
    for (const calendar of calendars.values()) {
      const path = splitCollectionPath(calendar.collection_path)
      if (path && listed.has(path.owner) && !existing.has(calendar.collection_path)) {
        gone.add(calendar.id)
      }
    }
    const shares = desired.shares.filter(
      (share) => share.calendarId === null || !gone.has(share.calendarId),
    )
    for (const id of gone) differences.push(`calendar ${id} is missing in Radicale`)

    const byOwner = new Map<string, DesiredShare[]>()
    const owners = new Set<string>([RESOURCES_PRINCIPAL, ...sharedOwners])
    for (const user of db.prepare<[], { oidc_sub: string }>('SELECT oidc_sub FROM users').all()) {
      if (isValidSubject(user.oidc_sub) && isActingPrincipal(user.oidc_sub))
        owners.add(user.oidc_sub)
    }
    for (const share of shares) {
      owners.add(share.owner)
      byOwner.set(share.owner, [...(byOwner.get(share.owner) ?? []), share])
    }
    const ownerList = [...owners].filter(isActingPrincipal).sort()

    if (withAvailability) {
      const ensured = await ensureAvailabilityCollection(client)
      if (!ensured.ok) {
        if (ensured.failure.kind === 'unreachable') return ensured
        differences.push(`availability collection: ${ensured.failure.message}`)
        failedShares.add(desiredKey(availabilityShare()))
      }
    }

    const unappliedKeys = new Set<string>()
    for (const row of rows) {
      const status = desired.rows.get(row.id)
      if (row.applied_at === null && status?.kind === 'share') unappliedKeys.add(status.key)
    }

    let created = 0
    let updated = 0
    let removed = 0
    const brokenOwners = new Set<string>()

    async function listOwner(
      owner: string,
    ): Promise<SharingResult<{ maps: RadicaleShare[]; tokens: RadicaleShare[] }>> {
      const maps = await client.listShares(owner, 'map')
      if (!maps.ok) return maps
      // Token shares are not ours to create, so any of them is unknown. Radicale answers 404 to
      // every token call unless collection_by_token is on; then there is nothing to list.
      const tokens = await client.listShares(owner, 'token')
      if (!tokens.ok && tokens.failure.kind === 'unreachable') return tokens
      return { ok: true, value: { maps: maps.value, tokens: tokens.ok ? tokens.value : [] } }
    }

    for (const owner of ownerList) {
      const current = await listOwner(owner)
      if (!current.ok) {
        if (current.failure.kind === 'unreachable') return current
        brokenOwners.add(owner)
        differences.push(`cannot list the shares of ${owner}: ${current.failure.message}`)
        continue
      }
      const wanted = byOwner.get(owner) ?? []
      const plan = planOwner(owner, wanted, current.value.maps, current.value.tokens)

      for (const { share, type, reason } of plan.deletes) {
        const result = await client.deleteShare(owner, type, share.pathOrToken)
        if (!result.ok) {
          if (result.failure.kind === 'unreachable') return result
          differences.push(`cannot remove ${describe(owner, share)}: ${result.failure.message}`)
          continue
        }
        if (reason === 'unknown') {
          removed += 1
          log.warn(`[sharing] removed a share SQLite does not know: ${describe(owner, share)}`)
          audit('sharing.removed_unknown', `${owner}${share.pathMapped}`, {
            owner,
            type,
            pathMapped: share.pathMapped,
            pathOrToken: share.pathOrToken,
            user: share.user,
            permissions: share.permissions,
          })
        } else {
          updated += 1
          audit('sharing.replaced', `${owner}${share.pathMapped}`, {
            owner,
            pathMapped: share.pathMapped,
            user: share.user,
            was: share.permissions,
          })
        }
      }
      const toAccept = new Map<string, DesiredShare>()
      for (const share of plan.creates) {
        const result = await client.createShare(owner, share)
        if (!result.ok) {
          if (result.failure.kind === 'unreachable') return result
          failedShares.add(desiredKey(share))
          differences.push(`cannot create ${describe(owner, share)}: ${result.failure.message}`)
          continue
        }
        created += 1
        toAccept.set(desiredKey(share), share)
      }
      for (const share of plan.reaccept) toAccept.set(desiredKey(share), share)
      for (const share of wanted) {
        if (share.kind === 'user' && unappliedKeys.has(desiredKey(share))) {
          toAccept.set(desiredKey(share), share)
        }
      }
      for (const share of toAccept.values()) {
        if (share.kind !== 'user') continue
        const result = await client.acceptShare(share.user, share.pathOrToken)
        if (!result.ok) {
          if (result.failure.kind === 'unreachable') return result
          failedShares.add(desiredKey(share))
          differences.push(`cannot enable ${describe(owner, share)}: ${result.failure.message}`)
        }
      }
    }

    // Read everything again and compare: the confirmation that Radicale holds what SQLite says.
    const verifiedKeys = new Set<string>()
    const verifiedOwners = new Set<string>()
    for (const owner of ownerList) {
      if (brokenOwners.has(owner)) continue
      const current = await listOwner(owner)
      if (!current.ok) {
        if (current.failure.kind === 'unreachable') return current
        differences.push(`cannot re-read the shares of ${owner}: ${current.failure.message}`)
        continue
      }
      const wanted = byOwner.get(owner) ?? []
      const plan = planOwner(owner, wanted, current.value.maps, current.value.tokens)
      for (const item of plan.deletes) {
        differences.push(`unexpected ${describe(owner, item.share)} (${item.share.permissions})`)
      }
      for (const share of plan.creates) differences.push(`missing ${describe(owner, share)}`)
      if (plan.deletes.length === 0 && plan.creates.length === 0) verifiedOwners.add(owner)
      const broken = new Set(plan.creates.map(desiredKey))
      for (const item of plan.deletes) {
        broken.add(actualKey(owner, item.share))
      }
      for (const share of wanted) {
        const key = desiredKey(share)
        if (!broken.has(key) && !failedShares.has(key)) verifiedKeys.add(key)
      }
    }

    // One synchronous block: nothing can change a rule between the check and the mark.
    const fresh = listAllCalendarAcl(db)
    const snapshot = new Map(rows.map((row) => [row.id, row]))
    const toMark: number[] = []
    for (const row of fresh) {
      const before = snapshot.get(row.id)
      const status = desired.rows.get(row.id)
      if (
        row.applied_at !== null ||
        !before ||
        !status ||
        before.permission !== row.permission ||
        before.principal_type !== row.principal_type ||
        before.principal !== row.principal ||
        before.calendar_id !== row.calendar_id ||
        gone.has(row.calendar_id)
      ) {
        continue
      }
      if (status.kind === 'share' && verifiedKeys.has(status.key)) toMark.push(row.id)
      else if (status.kind === 'none' && verifiedOwners.has(status.owner)) toMark.push(row.id)
    }
    markCalendarAclApplied(db, toMark, now())
    const unapplied = fresh.filter((row) => row.applied_at === null).length - toMark.length

    return {
      ok: true,
      value: { created, updated, removed, applied: toMark.length, unapplied, differences },
    }
  }

  function alarm(summary: ReconcileSummary): void {
    const signature = [...summary.differences].sort().join('\n')
    if (summary.differences.length === 0) {
      lastAlarmSignature = ''
      return
    }
    log.error(
      `[sharing] Radicale differs from the access rules after reconcile (${summary.differences.length}): ${summary.differences
        .slice(0, 5)
        .join('; ')}`,
    )
    // Once per distinct difference, not every five minutes.
    if (signature !== lastAlarmSignature) {
      lastAlarmSignature = signature
      audit('sharing.mismatch', 'reconcile', {
        count: summary.differences.length,
        differences: summary.differences.slice(0, MAX_LISTED_DIFFERENCES),
      })
    }
  }

  return {
    async run() {
      state.lastRunAt = now().toISOString()
      let result: SharingResult<ReconcileSummary>
      try {
        result = await execute()
      } catch (error) {
        result = sharingFail(
          'malformed',
          `unexpected error: ${error instanceof Error ? error.message : 'unknown'}`,
        )
      }
      if (!result.ok) {
        noteFailure(result.failure)
        return result
      }
      if (escalated) {
        audit('sharing.recovered', 'reconcile', { failures: state.consecutiveFailures })
      }
      escalated = false
      state.consecutiveFailures = 0
      state.lastFailure = null
      state.lastSuccessAt = now().toISOString()
      state.lastSummary = result.value
      alarm(result.value)
      return result
    },
    state: () => ({ ...state }),
  }
}
