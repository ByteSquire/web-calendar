// One group sync run: read the groups from Kanidm, map the members to UUIDs, import the Kanidm
// groups into the app's tables (best effort), write the file. A run never throws. Any failure of
// the file leaves the file untouched.
import { USERS_GROUP } from './config'
import { writeGroupFile, type GroupFileFs, nodeGroupFileFs } from './file'
import { isGroupName, renderGroupFile } from './format'
import type { KanidmClient } from './kanidm'
import type { MemberResolver } from './members'
import type { GroupSyncPorts } from './ports'
import {
  fail,
  type FileGroup,
  type GroupSyncFailure,
  type KanidmGroup,
  type Logger,
  type Result,
} from './types'

/** Consecutive failed runs after which the log line and the audit event escalate. */
export const ESCALATE_AFTER_FAILURES = 5

/** "a, b and 3 more": up to five names for a log line. */
function nameSome(names: string[]): string {
  const more = names.length > 5 ? ` and ${names.length - 5} more` : ''
  return `${names.slice(0, 5).join(', ')}${more}`
}

/** SPN -> `sub`, or null for a member Kanidm does not show as a person. Kept for one run. */
type MemberCache = Map<string, string | null>

export interface GroupSyncServiceOptions {
  /** Null in app-only mode (no token): the file is written from the app's own groups. */
  client: KanidmClient | null
  /** Maps member SPNs to `sub` UUIDs (members.ts). Needed with a client. */
  resolver: MemberResolver | null
  ports: GroupSyncPorts
  log: Logger
  file: string
  adminGroup: string
  fs?: GroupFileFs
}

export type GroupSyncRunResult =
  { ok: true; outcome: 'written' | 'unchanged' } | { ok: false; failure: GroupSyncFailure }

export interface GroupSyncService {
  run(): Promise<GroupSyncRunResult>
}

export function createGroupSyncService(options: GroupSyncServiceOptions): GroupSyncService {
  const { log, ports, client, resolver } = options
  let failures = 0
  let alarmRaised = false
  // Members with no UUID: what the last run said, and how long the users group has waited.
  let pendingKey = ''
  let pendingRuns = 0
  let pendingAlarm = false
  // A custom group that a Kanidm group also has the name of: said once per name, not every run.
  const warnedCollisions = new Set<string>()
  // Said once per group name: its Kanidm members cannot be read as persons, or the group is gone.
  const warnedUnreadable = new Set<string>()
  const warnedGone = new Set<string>()
  // Every group name Kanidm listed in this run, or null when the list was not read. A name that
  // rules still use but Kanidm no longer lists is a deleted group, not a failure to read it.
  let listedNames: Set<string> | null = null

  function customGroups(): FileGroup[] {
    return ports.listCustomGroups?.() ?? []
  }

  /** Looks up the members that are not in the cache yet; one call to the resolver at most. */
  async function resolveMembers(spns: string[], cache: MemberCache): Promise<Result<true>> {
    const missing = spns.filter((spn) => !cache.has(spn))
    if (missing.length === 0) return { ok: true, value: true }
    if (!resolver) return fail('malformed', 'no member resolver is configured')
    const resolution = await resolver(missing)
    if (!resolution.ok) return resolution
    for (const spn of missing) cache.set(spn, resolution.value.uuids.get(spn) ?? null)
    return { ok: true, value: true }
  }

  /**
   * Reads the Kanidm group list and stores the non-built-in groups. Best effort: a list, lookup or
   * store failure is logged and the run goes on, with the file written as before. The members it
   * looked up are returned, so the file step does not ask Kanidm for them again.
   */
  async function importKanidmGroups(cache: MemberCache): Promise<void> {
    if (!client || !resolver || !ports.importKanidmGroups) return
    const listed = await client.listGroups()
    if (!listed.ok) {
      log.warn(`[group-sync] the Kanidm groups were not imported: ${listed.failure.message}`)
      return
    }
    listedNames = new Set(listed.value.map((group) => group.name))
    const appNames = new Set(customGroups().map((group) => group.name))
    const imported: KanidmGroup[] = []
    for (const group of listed.value) {
      if (group.builtin || !isGroupName(group.name)) continue
      if (appNames.has(group.name)) {
        // A Kanidm admin must not be able to put members into an app group.
        if (!warnedCollisions.has(group.name)) {
          warnedCollisions.add(group.name)
          log.warn(
            `[group-sync] the Kanidm group "${group.name}" has the name of an app group; the app group wins and the Kanidm group is skipped`,
          )
        }
        continue
      }
      imported.push(group)
    }
    const spns = [...new Set(imported.flatMap((group) => group.members))].sort()
    const resolved = await resolveMembers(spns, cache)
    if (!resolved.ok) {
      log.warn(`[group-sync] the Kanidm groups were not imported: ${resolved.failure.message}`)
      return
    }
    try {
      ports.importKanidmGroups(
        imported.map((group) => {
          const members = group.members.flatMap((spn) => {
            const uuid = cache.get(spn)
            return uuid ? [uuid] : []
          })
          // Members in Kanidm but none readable: keep what is stored (an empty list would take the
          // group's access away from everybody over a missing right of the sync account).
          if (group.members.length > 0 && members.length === 0) {
            if (!warnedUnreadable.has(group.name)) {
              warnedUnreadable.add(group.name)
              log.warn(
                `[group-sync] none of the ${group.members.length} member(s) of the Kanidm group "${group.name}" can be read as a person; its stored members are kept (is the sync account in idm_people_pii_read?)`,
              )
            }
            return { name: group.name, members, keepMembers: true }
          }
          warnedUnreadable.delete(group.name)
          return { name: group.name, members }
        }),
      )
    } catch {
      log.warn('[group-sync] the Kanidm groups could not be stored; they are not imported this run')
    }
  }

  async function attempt(cache: MemberCache): Promise<Result<'written' | 'unchanged'>> {
    const startedAt = new Date()
    let extra: string[]
    try {
      extra = await ports.listExtraGroups()
    } catch {
      return fail('extra-groups', 'cannot list the groups the access rules reference')
    }
    const names = [...new Set([options.adminGroup, USERS_GROUP, ...extra])].sort()
    const invalid = names.find((name) => !isGroupName(name))
    if (invalid !== undefined) return fail('invalid-content', `group name "${invalid}" is invalid`)

    // An app group answers from the app's own members; only the other names are read from Kanidm.
    const custom = customGroups()
    const customNames = new Set(custom.map((group) => group.name))
    let kanidm: KanidmGroup[] = []
    if (client) {
      // The admin group and the users group are always read. Another name that Kanidm's list of
      // this run does not have is a group that was deleted: it is left out of the file (nobody is
      // in it) instead of failing every run until someone edits the rule that names it.
      const toRead = names.filter((name) => {
        if (customNames.has(name)) return false
        const gone =
          listedNames !== null &&
          !listedNames.has(name) &&
          name !== options.adminGroup &&
          name !== USERS_GROUP
        if (gone && !warnedGone.has(name)) {
          warnedGone.add(name)
          log.warn(
            `[group-sync] the group "${name}" is used by a rule but Kanidm does not list it any more; it is left out of the group file`,
          )
        }
        return !gone
      })
      const answers = await Promise.all(toRead.map((name) => client.readGroup(name)))
      for (const answer of answers) if (!answer.ok) return answer
      kanidm = answers.flatMap((answer) => (answer.ok ? [answer.value] : []))
    }

    const spns = [...new Set(kanidm.flatMap((group) => group.members))].sort()
    if (client) {
      const resolved = await resolveMembers(spns, cache)
      if (!resolved.ok) return resolved
    }
    const pending = spns.filter((spn) => cache.get(spn) === null)
    const pendingSet = new Set(pending)
    // A member Kanidm does not show as a person (a service account, a nested group) has no UUID and
    // cannot be put in the file, so they are left out; everybody else's removals and additions go
    // ahead. If NOBODY of the users group can be mapped, the sync account most likely cannot read
    // persons (not in idm_people_pii_read): fail, as an empty file would take the group access away
    // from everyone.
    const usersMembers = kanidm.find((group) => group.name === USERS_GROUP)?.members ?? []
    const usersPending = usersMembers.filter((member) => pendingSet.has(member)).length
    if (usersMembers.length > 0 && usersPending === usersMembers.length) {
      return fail(
        'unresolved-members',
        `none of the ${usersMembers.length} member(s) of ${USERS_GROUP} can be read as a person in Kanidm (is the sync account in idm_people_pii_read?): ${nameSome(usersMembers)}`,
      )
    }
    notePending(pending, usersPending)
    const fileGroups: FileGroup[] = [
      ...custom,
      ...kanidm.map((group) => ({
        name: group.name,
        members: group.members.flatMap((member) => {
          const uuid = cache.get(member)
          return uuid ? [uuid] : []
        }),
      })),
    ]
    // Nothing to write: app-only mode without an app group. The file keeps what it has.
    if (fileGroups.length === 0) return { ok: true, value: 'unchanged' }

    const rendered = renderGroupFile(fileGroups)
    if (!rendered.ok) return rendered
    const written = await writeGroupFile(
      options.file,
      rendered.value,
      options.fs ?? nodeGroupFileFs,
    )
    if (written.ok && written.value === 'written') {
      ports.audit({
        action: 'group_sync.updated',
        details: {
          groups: fileGroups.map((group) => group.name).sort(),
          members: new Set(spns).size,
          ...(pending.length > 0 ? { pending: pending.length } : {}),
        },
      })
    }
    if (written.ok && client) revokeTokensOfRemovedUsers(fileGroups, startedAt, usersPending)
    return written
  }

  /**
   * Says so when the members without a UUID change, and escalates once when members of the users
   * group have waited for ESCALATE_AFTER_FAILURES runs in a row (their pending state also holds
   * the revoking of app tokens, see below).
   */
  function notePending(pending: string[], usersPending: number): void {
    const key = pending.join('\n')
    if (key !== pendingKey) {
      pendingKey = key
      if (pending.length > 0) {
        log.warn(
          `[group-sync] ${pending.length} member(s) cannot be read as a person in Kanidm and are left out of the group file (a service account or a nested group never is; for a person, check that the sync account is in idm_people_pii_read): ${nameSome(pending)}` +
            (usersPending > 0
              ? `; app tokens of removed users are not revoked while a member of ${USERS_GROUP} is waiting`
              : ''),
        )
      } else {
        log.info('[group-sync] every group member has a known UUID now')
      }
    }
    if (usersPending === 0) {
      pendingRuns = 0
      pendingAlarm = false
      return
    }
    pendingRuns += 1
    if (pendingRuns >= ESCALATE_AFTER_FAILURES && !pendingAlarm) {
      pendingAlarm = true
      log.error(
        `[group-sync] ${usersPending} member(s) of ${USERS_GROUP} still cannot be read as a person after ${pendingRuns} runs; app tokens of removed users are not revoked until they can`,
      )
      ports.audit({
        action: 'group_sync.members_pending',
        details: { members: usersPending, runs: pendingRuns },
      })
    }
  }

  /**
   * An app token is checked against the local database only, so a user who is no longer in the
   * users group would keep CalDAV access for as long as the token lives (security review
   * 2026-11-01, finding 2). Runs only after a run that read every group and wrote the file, so a
   * half answer from Kanidm never removes anybody. An EMPTY users group removes nobody: that is
   * far more likely a Kanidm or sync misconfiguration than an offboarding of everyone. So does a
   * run where a member of the users group has no UUID (`usersPending`): Kanidm did not show them
   * as a person this time, and leaving them out would look like a removal. It never
   * fails the run.
   */
  function revokeTokensOfRemovedUsers(
    fileGroups: FileGroup[],
    startedAt: Date,
    usersPending: number,
  ): void {
    if (!ports.revokeTokensOfNonMembers) return
    if (usersPending > 0) return
    const members = fileGroups.find((group) => group.name === USERS_GROUP)?.members ?? []
    if (members.length === 0) {
      log.warn(`[group-sync] ${USERS_GROUP} has no members: no app tokens are revoked`)
      return
    }
    try {
      const { users, revoked } = ports.revokeTokensOfNonMembers(new Set(members), startedAt)
      if (revoked > 0) {
        log.info(
          `[group-sync] revoked ${revoked} app token(s) of ${users} user(s) no longer in ${USERS_GROUP}`,
        )
      }
    } catch {
      log.warn('[group-sync] could not revoke the app tokens of removed users; will retry')
    }
  }

  function onFailure(failure: GroupSyncFailure): void {
    failures += 1
    if (failure.kind === 'unauthorized') {
      // Not a transient fault: the token is expired, revoked or lacks the right.
      log.error(
        `[group-sync] ALARM: ${failure.message}. Rotate the token (docs/kanidm-setup.md §3).`,
      )
      if (!alarmRaised) {
        alarmRaised = true
        ports.audit({ action: 'group_sync.unauthorized', details: { message: failure.message } })
      }
    } else {
      log.warn(`[group-sync] run failed, group file left unchanged: ${failure.message}`)
    }
    if (failures % ESCALATE_AFTER_FAILURES === 0) {
      log.error(
        `[group-sync] ${failures} runs in a row failed; the group file is stale and removed members keep access`,
      )
      ports.audit({
        action: 'group_sync.failing',
        details: { consecutiveFailures: failures, kind: failure.kind },
      })
    }
  }

  function onSuccess(): void {
    if (failures >= ESCALATE_AFTER_FAILURES || alarmRaised) {
      log.info(`[group-sync] recovered after ${failures} failed runs`)
      ports.audit({ action: 'group_sync.recovered', details: { consecutiveFailures: failures } })
    }
    failures = 0
    alarmRaised = false
  }

  return {
    async run() {
      let result: Result<'written' | 'unchanged'>
      // One cache per run: the import and the file look every member up once.
      const cache: MemberCache = new Map()
      listedNames = null
      try {
        await importKanidmGroups(cache)
      } catch {
        log.warn('[group-sync] the Kanidm groups were not imported: unexpected error')
      }
      try {
        result = await attempt(cache)
      } catch {
        result = fail('write-error', 'unexpected error in the group sync')
      }
      if (result.ok) {
        onSuccess()
        return { ok: true, outcome: result.value }
      }
      try {
        onFailure(result.failure)
      } catch {
        // Logging and auditing must not take the scheduler down.
      }
      return { ok: false, failure: result.failure }
    },
  }
}
