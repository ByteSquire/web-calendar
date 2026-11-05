// @vitest-environment node
// The group file written from the database (real SQLite, a real temp directory): it is a copy of
// the groups, the stored members and the people of the last days, nothing else reaches it, a run
// that changes nothing writes nothing, and a failed write leaves the old file in place.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertUser } from '../../server/db/users'
import { nodeGroupFileFs, type GroupFileFs } from '../../server/utils/groups/htgroup-file'
import { createGroupFileService } from '../../server/utils/groups/file-service'
import {
  noteActiveUser,
  requestGroupFileWrite,
  setActiveGroupFile,
} from '../../server/utils/groups/file-trigger'
import { openTestDb } from './api-fixtures'

const ALICE = 'alice-sub'
const BOB = 'Bob-Sub'
const CAROL = 'carol@example.org'
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-06-15T12:00:00.000Z')
const WINDOW = 30 * DAY

let db: Database
let dir: string
let file: string
let clock: Date
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

beforeEach(async () => {
  db = openTestDb()
  dir = await mkdtemp(join(tmpdir(), 'group-file-'))
  file = join(dir, 'htgroup')
  clock = NOW
  vi.clearAllMocks()
})
afterEach(async () => {
  setActiveGroupFile(undefined)
  db.close()
  await rm(dir, { recursive: true, force: true })
})

const service = (fs?: GroupFileFs) =>
  createGroupFileService({
    getDb: () => db,
    file,
    windowMs: WINDOW,
    log,
    fs,
    now: () => clock,
  })
const seen = (sub: string, daysAgo: number) =>
  upsertUser(db, { sub, username: sub }, new Date(NOW.getTime() - daysAgo * DAY))
const text = () => readFile(file, 'utf8')
const addGroup = (name: string, source: 'app' | 'oidc', subs: string[]) => {
  const id = db
    .prepare(`INSERT INTO groups (name, source, external_id) VALUES (?, ?, ?) RETURNING id`)
    .pluck()
    .get(name, source, source === 'oidc' ? `${name}-id` : null) as number
  for (const sub of subs) {
    db.prepare('INSERT INTO group_members (group_id, sub) VALUES (?, ?)').run(id, sub)
  }
}

describe('the content', () => {
  it('has the app groups, the imported groups and the line of everyone, sorted', async () => {
    seen(ALICE, 1)
    seen(BOB, 10)
    seen(CAROL, 100)
    addGroup('team', 'app', [BOB, ALICE])
    addGroup('from_idp', 'oidc', [CAROL])
    addGroup('empty', 'app', [])
    expect(await service().run()).toBe(true)
    // Capitals sort before lower case: ids are compared as they are.
    expect(await text()).toBe(
      [
        'empty:',
        'from_idp: carol@example.org',
        'team: Bob-Sub alice-sub',
        'web_calendar_users: Bob-Sub alice-sub',
      ].join('\n') + '\n',
    )
  })

  it('has only the line of everyone, empty, on a fresh database', async () => {
    expect(await service().run()).toBe(true)
    expect(await text()).toBe('web_calendar_users:\n')
  })

  it('lets a person leave the line of everyone when the window passes, and come back', async () => {
    seen(ALICE, 29)
    const svc = service()
    await svc.run()
    expect(await text()).toContain('web_calendar_users: alice-sub')
    clock = new Date(NOW.getTime() + 2 * DAY)
    await svc.run()
    expect(await text()).toBe('web_calendar_users:\n')
    upsertUser(db, { sub: ALICE, username: 'alice' }, clock)
    await svc.run()
    expect(await text()).toContain('web_calendar_users: alice-sub')
  })

  it('does not drop imported or app members with the window: only the line of everyone is bounded', async () => {
    seen(ALICE, 400)
    addGroup('team', 'app', [ALICE])
    addGroup('from_idp', 'oidc', [ALICE])
    await service().run()
    const content = await text()
    expect(content).toContain('team: alice-sub')
    expect(content).toContain('from_idp: alice-sub')
    expect(content).toContain('web_calendar_users:\n')
  })

  it('leaves out a member that is no valid user id, says so once, and still writes the rest', async () => {
    addGroup('team', 'app', [ALICE, 'a b', 'x/y'])
    const svc = service()
    expect(await svc.run()).toBe(true)
    expect(await text()).toContain('team: alice-sub\n')
    expect(await text()).not.toContain('a b')
    expect(log.warn).toHaveBeenCalledTimes(1)
    await svc.run()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})

describe('writing', () => {
  it('writes nothing when nothing changed: same file, same time, no backup', async () => {
    seen(ALICE, 1)
    const svc = service()
    await svc.run()
    const before = await stat(file)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(await svc.run()).toBe(true)
    const after = await stat(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
    expect(await readdir(dir)).toEqual(['htgroup'])
  })

  it('keeps the previous file next to the new one', async () => {
    const svc = service()
    await svc.run()
    seen(ALICE, 1)
    await svc.run()
    expect(await readFile(`${file}.prev`, 'utf8')).toBe('web_calendar_users:\n')
    expect(await text()).toBe('web_calendar_users: alice-sub\n')
  })

  it('leaves the old file alone when the write fails, says so once, and recovers', async () => {
    seen(ALICE, 1)
    const svc = service()
    await svc.run()
    const old = await text()
    seen(BOB, 1)
    let broken = true
    const failing: GroupFileFs = {
      ...nodeGroupFileFs,
      rename: async (from, to) => {
        if (broken) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        return nodeGroupFileFs.rename(from, to)
      },
    }
    const bad = service(failing)
    expect(await bad.run()).toBe(false)
    expect(await bad.run()).toBe(false)
    expect(await text()).toBe(old)
    expect(await readdir(dir)).not.toContain('htgroup.tmp')
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error.mock.calls[0]![0]).toContain('ENOSPC')
    broken = false
    expect(await bad.run()).toBe(true)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('written again'))
    expect(await text()).toContain('Bob-Sub')
  })

  it('reports a missing directory as a failure instead of throwing', async () => {
    file = join(dir, 'missing', 'htgroup')
    expect(await service().run()).toBe(false)
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('reports a database that is down as a failure instead of throwing', async () => {
    const svc = createGroupFileService({
      getDb: () => {
        throw new Error('database is down')
      },
      file,
      windowMs: WINDOW,
      log,
    })
    expect(await svc.run()).toBe(false)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('database is down'))
  })

  it('replaces a file that somebody else made', async () => {
    await writeFile(file, 'old_group: nobody\n')
    await service().run()
    expect(await text()).toBe('web_calendar_users:\n')
  })
})

describe('who is listed', () => {
  it('knows, after a write, whom the line of everyone has', async () => {
    seen(ALICE, 1)
    const svc = service()
    // Before the first write the coming write covers everybody.
    expect(svc.listed(BOB)).toBe(true)
    await svc.run()
    expect(svc.listed(ALICE)).toBe(true)
    expect(svc.listed(BOB)).toBe(false)
    seen(BOB, 0)
    await svc.run()
    expect(svc.listed(BOB)).toBe(true)
  })

  it('never asks for a write over an id that cannot be in the file', async () => {
    const svc = service()
    await svc.run()
    expect(svc.listed('a b')).toBe(true)
  })
})

describe('the trigger', () => {
  it('does nothing without a running writer', () => {
    expect(() => requestGroupFileWrite()).not.toThrow()
    expect(() => noteActiveUser(ALICE)).not.toThrow()
  })

  it('hands requests and active people to the running writer', () => {
    const request = vi.fn()
    const noteActive = vi.fn()
    setActiveGroupFile({ request, noteActive })
    requestGroupFileWrite()
    noteActiveUser(ALICE)
    expect(request).toHaveBeenCalledTimes(1)
    expect(noteActive).toHaveBeenCalledWith(ALICE)
  })
})
