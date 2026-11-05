// Writes Radicale's group file from the database: every app group and imported group with its
// stored members, and the group of everyone with the people who signed in within the window. The
// file is a copy, never the truth: authorization reads the database, Radicale reads the file.
// Writing is atomic and skipped when the content did not change (see htgroup-file.ts).
import type { Database } from 'better-sqlite3'
import { listGroupsForFile } from '../../db/groups'
import { signinCutoff } from '../auth/window'
import { isValidSubject } from '../auth/subject'
import { USERS_GROUP } from './config'
import { renderGroupFile } from './htgroup'
import { nodeGroupFileFs, writeGroupFile, type GroupFileFs } from './htgroup-file'

export interface GroupFileLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface GroupFileServiceOptions {
  getDb(): Database
  /** The path of the group file. */
  file: string
  /** The sign-in window in milliseconds. */
  windowMs: number
  log: GroupFileLogger
  fs?: GroupFileFs
  now?: () => Date
}

export interface GroupFileService {
  /** One write; resolves true when the file is as the database says (also when nothing changed). */
  run(): Promise<boolean>
  /** Whether the last written file had `sub` in the line of everyone. */
  listed(sub: string): boolean
}

export function createGroupFileService(options: GroupFileServiceOptions): GroupFileService {
  const { log } = options
  const now = options.now ?? (() => new Date())
  // The people in the line of everyone as last written; null before the first write.
  let listedSubs: Set<string> | null = null
  let lastFailure = ''
  let lastSkipped = 0

  function failed(message: string): false {
    // Said once per run of identical failures, not on every retry.
    if (message !== lastFailure) log.error(`[group-file] ${message}`)
    lastFailure = message
    return false
  }

  return {
    async run() {
      try {
        const { groups, skipped } = listGroupsForFile(
          options.getDb(),
          signinCutoff(options.windowMs, now()),
        )
        if (skipped !== lastSkipped) {
          lastSkipped = skipped
          if (skipped > 0) {
            log.warn(`[group-file] ${skipped} member id(s) are not valid user ids and are left out`)
          }
        }
        const rendered = renderGroupFile(groups)
        if (!rendered.ok) return failed(rendered.failure.message)
        const written = await writeGroupFile(
          options.file,
          rendered.value,
          options.fs ?? nodeGroupFileFs,
        )
        if (!written.ok) return failed(written.failure.message)
        const everyone = groups.find((group) => group.name === USERS_GROUP)
        listedSubs = new Set(everyone?.members ?? [])
        if (lastFailure !== '') log.info('[group-file] the group file is written again')
        lastFailure = ''
        return true
      } catch (error) {
        return failed(
          `unexpected error: ${error instanceof Error ? error.message : 'unknown error'}`,
        )
      }
    },
    // Before the first write nobody is known to be in: the write that is coming covers them.
    listed: (sub) => listedSubs === null || listedSubs.has(sub) || !isValidSubject(sub),
  }
}
