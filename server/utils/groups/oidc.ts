// Groups from the identity provider, from the admin's side: which groups the claim has shown
// (candidates), importing one, and stopping. The membership of an imported group follows each
// person's sign-in (import.ts); this file only decides which groups exist. Like the rest of the
// group services it runs inside the route's transaction, so its audit entry is written with the
// change.
import type { Database } from 'better-sqlite3'
import {
  countGroupCalendars,
  countGroups,
  countRulesNamingGroup,
  deleteGroupRow,
  deleteRulesNamingGroup,
  groupNameTaken,
} from '../../db/groups'
import type { GroupRow, OidcGroupCandidateRow } from '../../db/types'
import { conflict, notFound } from '../api/errors'
import { isAdminGroupKey, isIgnored, reservedGroupNames } from './claim'
import { MAX_GROUPS } from './rules'

/** The most candidates one list holds; a provider with more shows the first and says so. */
export const MAX_CANDIDATES = 1000

export type CandidateBlock =
  /** Two keys of the provider have this name; neither can be imported until one is renamed there. */
  | 'conflict'
  /** A group of the app (any source) already has the name. */
  | 'name_taken'

export interface CandidateView {
  /** The provider's key, as the claim has it: what an import names. */
  id: string
  name: string
  imported: boolean
  /** The group's id when it is imported (what Stop importing names). */
  groupId: number | null
  memberCount: number
  lastSeenAt: string
  /** Why Import is not possible, or null. Always null for an imported group. */
  blocked: CandidateBlock | null
}

interface CandidateRow extends OidcGroupCandidateRow {
  group_id: number | null
  member_count: number
  name_taken: number
}

/** A candidate that is never offered: it is the admin group (by name or key) or the group of everyone. */
function isReserved(candidate: { name: string; external_id: string }, adminGroup: string): boolean {
  return (
    reservedGroupNames(adminGroup).includes(candidate.name.toLowerCase()) ||
    isAdminGroupKey(candidate.external_id, adminGroup)
  )
}

/**
 * The groups the claim has shown, by name. Left out: those on the ignore list (also those seen
 * before the list was set) and those with a reserved name, unless they are imported already, so an
 * admin can always stop importing a group.
 */
export function listCandidates(
  db: Database,
  options: { ignore: readonly string[]; adminGroup: string },
): { candidates: CandidateView[]; truncated: boolean } {
  const rows = db
    .prepare<[], CandidateRow>(
      `SELECT c.external_id, c.name, c.conflict, c.first_seen_at, c.last_seen_at,
         g.id AS group_id,
         (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
         EXISTS (SELECT 1 FROM groups o WHERE o.name = c.name COLLATE NOCASE
                 AND (g.id IS NULL OR o.id <> g.id)) AS name_taken
       FROM oidc_group_candidates c
       LEFT JOIN groups g ON g.source = 'oidc' AND g.external_id = c.external_id
       ORDER BY c.name COLLATE NOCASE, c.external_id`,
    )
    .all()
  const shown: CandidateView[] = []
  for (const row of rows) {
    const imported = row.group_id !== null
    if (!imported && (isIgnored(row.name, options.ignore) || isReserved(row, options.adminGroup))) {
      continue
    }
    shown.push({
      id: row.external_id,
      name: row.name,
      imported,
      groupId: row.group_id,
      memberCount: row.member_count,
      lastSeenAt: row.last_seen_at,
      blocked: imported
        ? null
        : row.conflict === 1
          ? 'conflict'
          : row.name_taken === 1
            ? 'name_taken'
            : null,
    })
  }
  return { candidates: shown.slice(0, MAX_CANDIDATES), truncated: shown.length > MAX_CANDIDATES }
}

/**
 * Imports a candidate as a group with its name. Refused with 404 for a key the claim never showed,
 * and with 409 when the group is imported already, when two keys share the name, when another group
 * has the name, or at the limit. A name on the ignore list or a reserved one is never offered, so
 * it is refused here too (404, as for an unknown key). The new group has no members: people join
 * it when they sign in.
 */
export function importCandidate(
  db: Database,
  externalId: string,
  options: { ignore: readonly string[]; adminGroup: string },
): GroupRow {
  const candidate = db
    .prepare<[string], OidcGroupCandidateRow>(
      'SELECT * FROM oidc_group_candidates WHERE external_id = ?',
    )
    .get(externalId)
  if (
    !candidate ||
    isIgnored(candidate.name, options.ignore) ||
    isReserved(candidate, options.adminGroup)
  ) {
    throw notFound()
  }
  const imported = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM groups WHERE source = 'oidc' AND external_id = ?`,
    )
    .get(externalId)
  if (imported) throw conflict('duplicate', 'This group is imported already')
  if (candidate.conflict === 1) {
    throw conflict(
      'duplicate',
      'Two groups of the identity provider have this name; one has to be renamed there first',
    )
  }
  if (groupNameTaken(db, candidate.name)) {
    throw conflict('duplicate', 'A group with this name exists already')
  }
  if (countGroups(db) >= MAX_GROUPS) {
    throw conflict('limit_reached', `There are at most ${MAX_GROUPS} groups`)
  }
  return db
    .prepare<[string, string], GroupRow>(
      `INSERT INTO groups (name, source, external_id) VALUES (?, 'oidc', ?) RETURNING *`,
    )
    .get(candidate.name, externalId)!
}

/**
 * Stops importing a group: the group goes with its members and the rules that name it (calendar and
 * resource rules; the sharing writer removes the shares). The candidate stays, so the group can be
 * imported again. Refused while the group owns calendars (409 `has_calendars`).
 */
export function stopImporting(
  db: Database,
  group: GroupRow,
): { calendarRules: number; resourceRules: number } {
  if (group.source !== 'oidc') throw notFound()
  if (countGroupCalendars(db, group.id) > 0) {
    throw conflict('has_calendars', 'The group still owns calendars; delete them first')
  }
  const rules = countRulesNamingGroup(db, group.name)
  deleteRulesNamingGroup(db, group.name)
  deleteGroupRow(db, group.id)
  return { calendarRules: rules.calendar, resourceRules: rules.resource }
}
