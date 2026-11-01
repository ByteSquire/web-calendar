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
    return written
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
