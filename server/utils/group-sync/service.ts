// One group sync run: read the groups from Kanidm, map the members to UUIDs, write the file.
// A run never throws. Any failure leaves the file untouched.
import { USERS_GROUP } from './config'
import { writeGroupFile, type GroupFileFs, nodeGroupFileFs } from './file'
import { isGroupName, renderGroupFile } from './format'
import type { KanidmClient } from './kanidm'
import type { MemberResolver } from './members'
import type { GroupSyncPorts } from './ports'
import { fail, type FileGroup, type GroupSyncFailure, type Logger, type Result } from './types'

/** Consecutive failed runs after which the log line and the audit event escalate. */
export const ESCALATE_AFTER_FAILURES = 5

export interface GroupSyncServiceOptions {
  client: KanidmClient
  /** Resolves per run, so it can use a database that opens later. */
  resolver: () => MemberResolver
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
  const { log, ports } = options
  let failures = 0
  let alarmRaised = false

  async function attempt(): Promise<Result<'written' | 'unchanged'>> {
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

    const answers = await Promise.all(names.map((name) => options.client.readGroup(name)))
    for (const answer of answers) if (!answer.ok) return answer
    const groups = answers.flatMap((answer) => (answer.ok ? [answer.value] : []))

    const spns = [...new Set(groups.flatMap((group) => group.members))].sort()
    const resolved = options.resolver()(spns)
    if (!resolved.ok) return resolved
    const fileGroups: FileGroup[] = groups.map((group) => ({
      name: group.name,
      members: group.members.map((member) => resolved.value.get(member) ?? member),
    }))

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
        details: { groups: names, members: new Set(spns).size },
      })
    }
    if (written.ok) revokeTokensOfRemovedUsers(fileGroups, startedAt)
    return written
  }

  /**
   * An app token is checked against the local database only, so a user who is no longer in the
   * users group would keep CalDAV access for as long as the token lives (security review
   * 2026-11-01, finding 2). Runs only after a run that read every group and wrote the file, so a
   * half answer from Kanidm never removes anybody. An EMPTY users group removes nobody: that is
   * far more likely a Kanidm or sync misconfiguration than an offboarding of everyone. It never
   * fails the run.
   */
  function revokeTokensOfRemovedUsers(fileGroups: FileGroup[], startedAt: Date): void {
    if (!ports.revokeTokensOfNonMembers) return
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
      try {
        result = await attempt()
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
