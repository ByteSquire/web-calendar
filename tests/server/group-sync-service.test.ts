// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertUser } from '../../server/db/users'
import { resolveMe } from '../../server/utils/api/me'
import {
  createGroupsTracker,
  noteUserGroups,
  requestGroupSyncRun,
  setActiveGroupSync,
} from '../../server/utils/group-sync/active'
import { clampIntervalSec, groupFilePath } from '../../server/utils/group-sync/config'
import { createKanidmClient } from '../../server/utils/group-sync/kanidm'
import {
  createUsersTableResolver,
  type MemberResolver,
} from '../../server/utils/group-sync/members'
import { createDefaultPorts, type GroupSyncAuditEvent } from '../../server/utils/group-sync/ports'
import { createGroupSyncScheduler } from '../../server/utils/group-sync/scheduler'
import {
  createGroupSyncService,
  ESCALATE_AFTER_FAILURES,
} from '../../server/utils/group-sync/service'
import { openTestDb } from './api-fixtures'

const TOKEN = 'sync-secret-token-123'
const ALICE = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const BOB = '6f9f0e2d-0000-4000-8000-000000000002'
const SPNS: Record<string, string> = { 'alice@idm.example.org': ALICE, 'bob@idm.example.org': BOB }

const groupBody = (name: string, member: string[]) =>
  JSON.stringify({ attrs: { class: ['group'], name: [name], member } })

describe('group sync run', () => {
  let dir: string
  let file: string
  let answers: Record<string, () => Response>
  let logs: string[]
  let audits: GroupSyncAuditEvent[]
  let extra: string[]
  let revokes: { members: string[]; createdBefore: Date }[]
  let revokeThrows: boolean
  /** What the stub port says it revoked; nothing, unless a test is about that. */
  let revoked: { users: number; revoked: number }

  const resolver: MemberResolver = (spns) => {
    const unknown = spns.filter((spn) => !SPNS[spn])
    if (unknown.length > 0) {
      return {
        ok: false,
        failure: { kind: 'unresolved-members', message: `unknown ${unknown.join(',')}` },
      }
    }
    return { ok: true, value: new Map(spns.map((spn) => [spn, SPNS[spn] as string])) }
  }

  function service() {
    const line = (level: string) => (message: string) => void logs.push(`${level} ${message}`)
    return createGroupSyncService({
      client: createKanidmClient({
        origin: 'https://idm.example.org',
        token: TOKEN,
        fetch: async (input) => {
          const name = decodeURIComponent(String(input).split('/').pop() ?? '')
          const answer = answers[name]
          if (!answer) throw new TypeError(`fetch failed (${TOKEN})`)
          return answer()
        },
      }),
      resolver: () => resolver,
      ports: {
        listExtraGroups: () => extra,
        audit: (event) => void audits.push(event),
        revokeTokensOfNonMembers: (members, createdBefore) => {
          if (revokeThrows) throw new Error('database is locked')
          revokes.push({ members: [...members].sort(), createdBefore })
          return revoked
        },
      },
      log: { info: line('info'), warn: line('warn'), error: line('error') },
      file,
      adminGroup: 'calendar_admins',
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'group-sync-svc-'))
    file = join(dir, 'htgroup')
    logs = []
    audits = []
    extra = []
    revokes = []
    revokeThrows = false
    revoked = { users: 0, revoked: 0 }
    answers = {
      calendar_admins: () => new Response(groupBody('calendar_admins', ['alice@idm.example.org'])),
      web_calendar_users: () =>
        new Response(
          groupBody('web_calendar_users', ['bob@idm.example.org', 'alice@idm.example.org']),
        ),
    }
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('writes the exact file from the fixture answers', async () => {
    expect(await service().run()).toEqual({ ok: true, outcome: 'written' })
    expect(await readFile(file, 'utf8')).toBe(
      `calendar_admins: ${ALICE}\nweb_calendar_users: ${ALICE} ${BOB}\n`,
    )
    expect(audits.map((event) => event.action)).toEqual(['group_sync.updated'])
  })

  describe('app tokens of users who left the users group (security review 2026-11-01)', () => {
    it('revokes the tokens of everybody outside the users group after a good run', async () => {
      revoked = { users: 2, revoked: 3 }
      const before = Date.now()
      await service().run()
      expect(revokes).toHaveLength(1)
      expect(revokes[0]!.members).toEqual([ALICE, BOB].sort())
      // The cut-off is when the run began, so a token made while it ran is safe.
      expect(revokes[0]!.createdBefore.getTime()).toBeGreaterThanOrEqual(before)
      expect(revokes[0]!.createdBefore.getTime()).toBeLessThanOrEqual(Date.now())
      expect(logs).toContain(
        'info [group-sync] revoked 3 app token(s) of 2 user(s) no longer in web_calendar_users',
      )
    })

    it('also does it when the file did not change (the first run after an update)', async () => {
      const sync = service()
      await sync.run()
      expect(await sync.run()).toEqual({ ok: true, outcome: 'unchanged' })
      expect(revokes).toHaveLength(2)
    })

    it('uses the members of the users group, not of the admin group or the extra groups', async () => {
      extra = ['team_a']
      answers.team_a = () => new Response(groupBody('team_a', ['bob@idm.example.org']))
      answers.web_calendar_users = () =>
        new Response(groupBody('web_calendar_users', ['alice@idm.example.org']))
      await service().run()
      expect(revokes[0]!.members).toEqual([ALICE])
    })

    it.each([
      ['Kanidm answered null', () => (answers.web_calendar_users = () => new Response('null'))],
      [
        'Kanidm answered with an error',
        () => (answers.web_calendar_users = () => new Response('oops', { status: 500 })),
      ],
      [
        'a member cannot be resolved',
        () =>
          (answers.web_calendar_users = () =>
            new Response(groupBody('web_calendar_users', ['mallory@idm.example.org']))),
      ],
      ['a group cannot be read at all', () => delete answers.web_calendar_users],
    ])('removes nobody when the run fails: %s', async (_name, breakIt) => {
      breakIt()
      expect((await service().run()).ok).toBe(false)
      expect(revokes).toEqual([])
    })

    it('removes nobody when the users group is empty, and says so', async () => {
      answers.web_calendar_users = () => new Response(groupBody('web_calendar_users', []))
      expect((await service().run()).ok).toBe(true)
      expect(revokes).toEqual([])
      expect(logs).toContain(
        'warn [group-sync] web_calendar_users has no members: no app tokens are revoked',
      )
    })

    it('does not fail the run, nor lose the file, when the revoking fails', async () => {
      revokeThrows = true
      expect(await service().run()).toEqual({ ok: true, outcome: 'written' })
      expect(await readFile(file, 'utf8')).toContain(`web_calendar_users: ${ALICE} ${BOB}`)
      expect(logs).toContain(
        'warn [group-sync] could not revoke the app tokens of removed users; will retry',
      )
    })

    it('is optional: ports without it leave the tokens alone', async () => {
      const ports = createDefaultPorts(() => {})
      expect(ports.revokeTokensOfNonMembers).toBeUndefined()
      await expect(
        createGroupSyncService({
          client: createKanidmClient({
            origin: 'https://idm.example.org',
            token: TOKEN,
            fetch: async (input) =>
              answers[decodeURIComponent(String(input).split('/').pop() ?? '')]!(),
          }),
          resolver: () => resolver,
          ports,
          log: { info() {}, warn() {}, error() {} },
          file,
          adminGroup: 'calendar_admins',
        }).run(),
      ).resolves.toEqual({ ok: true, outcome: 'written' })
    })
  })

  it('reads the extra groups of the access rules too', async () => {
    extra = ['team_a']
    answers.team_a = () => new Response(groupBody('team_a', ['bob@idm.example.org']))
    await service().run()
    expect(await readFile(file, 'utf8')).toContain(`team_a: ${BOB}\n`)
  })

  it('a removed member is gone after one run, and .prev has the old file', async () => {
    const sync = service()
    await sync.run()
    answers.web_calendar_users = () =>
      new Response(groupBody('web_calendar_users', ['alice@idm.example.org']))
    await sync.run()
    expect(await readFile(file, 'utf8')).toBe(
      `calendar_admins: ${ALICE}\nweb_calendar_users: ${ALICE}\n`,
    )
    expect(await readFile(`${file}.prev`, 'utf8')).toContain(BOB)
  })

  it('leaves the file untouched on null, an error, or an unresolvable member', async () => {
    const sync = service()
    await sync.run()
    const before = await readFile(file, 'utf8')
    const cases: (() => void)[] = [
      () => (answers.web_calendar_users = () => new Response('null')),
      () => (answers.web_calendar_users = () => new Response('oops', { status: 500 })),
      () => delete answers.web_calendar_users,
      () =>
        (answers.web_calendar_users = () =>
          new Response(groupBody('web_calendar_users', ['mallory@idm.example.org']))),
    ]
    for (const breakIt of cases) {
      breakIt()
      expect((await sync.run()).ok).toBe(false)
      expect(await readFile(file, 'utf8')).toBe(before)
    }
    expect(logs.every((line) => line.startsWith('warn'))).toBe(true)
  })

  it('never creates an empty file because Kanidm answered null', async () => {
    answers.web_calendar_users = () => new Response('null')
    await service().run()
    expect(await readdir(dir)).toEqual([])
  })

  it('does not rewrite an unchanged file', async () => {
    const sync = service()
    await sync.run()
    audits.length = 0
    expect(await sync.run()).toEqual({ ok: true, outcome: 'unchanged' })
    expect(audits).toEqual([])
  })

  it('raises an alarm with a distinct audit action on 401 and 403', async () => {
    await writeFile(file, '')
    for (const status of [401, 403]) {
      answers.calendar_admins = () => new Response('no', { status })
      const result = await service().run()
      expect(!result.ok && result.failure.kind).toBe('unauthorized')
    }
    expect(logs.some((line) => line.startsWith('error') && line.includes('ALARM'))).toBe(true)
    expect(audits.map((event) => event.action)).toEqual([
      'group_sync.unauthorized',
      'group_sync.unauthorized',
    ])
    expect(await readFile(file, 'utf8')).toBe('')
  })

  it('escalates after repeated failures and reports the recovery', async () => {
    const sync = service()
    answers.calendar_admins = () => new Response('null')
    for (let i = 0; i < ESCALATE_AFTER_FAILURES - 1; i += 1) await sync.run()
    expect(audits).toEqual([])
    expect(logs.some((line) => line.startsWith('error'))).toBe(false)
    await sync.run()
    expect(audits.map((event) => event.action)).toEqual(['group_sync.failing'])
    expect(logs.some((line) => line.startsWith('error'))).toBe(true)
    answers.calendar_admins = () =>
      new Response(groupBody('calendar_admins', ['alice@idm.example.org']))
    await sync.run()
    expect(audits.map((event) => event.action)).toEqual([
      'group_sync.failing',
      'group_sync.updated',
      'group_sync.recovered',
    ])
  })

  it('never puts the token into a log line or an audit event', async () => {
    const sync = service()
    await sync.run()
    delete answers.calendar_admins // fetch throws an error that contains the token
    await sync.run()
    answers.calendar_admins = () => new Response(TOKEN, { status: 403 })
    await sync.run()
    answers.calendar_admins = () => new Response(`{"${TOKEN}`)
    for (let i = 0; i < ESCALATE_AFTER_FAILURES; i += 1) await sync.run()
    expect(logs.length).toBeGreaterThan(3)
    expect(JSON.stringify([logs, audits])).not.toContain(TOKEN)
  })

  it('never throws, whatever the ports do', async () => {
    extra = []
    const sync = createGroupSyncService({
      client: { readGroup: () => Promise.reject(new Error('boom')) },
      resolver: () => resolver,
      ports: {
        listExtraGroups: () => [],
        audit: () => {
          throw new Error('audit down')
        },
      },
      log: console,
      file,
      adminGroup: 'calendar_admins',
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect((await sync.run()).ok).toBe(false)
  })
})

describe('createUsersTableResolver', () => {
  let db: Database
  beforeEach(() => {
    db = openTestDb()
  })
  afterEach(() => db.close())

  it('maps an SPN to the sub of the user and fails on one nobody knows', () => {
    upsertUser(db, { sub: ALICE, username: 'alice@idm.example.org' })
    const resolve = createUsersTableResolver(db)
    expect(resolve(['Alice@idm.example.org'])).toEqual({
      ok: true,
      value: new Map([['Alice@idm.example.org', ALICE]]),
    })
    const missing = resolve(['alice@idm.example.org', 'bob@idm.example.org'])
    expect(!missing.ok && missing.failure.kind).toBe('unresolved-members')
    expect(!missing.ok && missing.failure.message).toContain('bob@idm.example.org')
  })
})

describe('createUsersTableResolver: short names (prefer-short-username)', () => {
  const ISSUER = 'https://idm.example.org/oauth2/openid/web-calendar'
  let db: Database
  beforeEach(() => {
    db = openTestDb()
  })
  afterEach(() => db.close())
  const resolveOne = (spn: string, issuer: string = ISSUER) =>
    createUsersTableResolver(db, { issuer })([spn])

  it('maps a member of the Kanidm domain to the user with the short name', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' })
    expect(resolveOne('alice@idm.example.org')).toEqual({
      ok: true,
      value: new Map([['alice@idm.example.org', ALICE]]),
    })
    // Case does not matter, as with the whole SPN.
    expect(resolveOne('Alice@IDM.example.org').ok).toBe(true)
  })

  it('accepts the domain of Kanidm when the issuer is a host within it', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' })
    const issuer = 'https://login.idm.example.org/oauth2/openid/web-calendar'
    expect(resolveOne('alice@idm.example.org', issuer).ok).toBe(true)
  })

  it('does not match a member of another domain with the same short name', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' })
    for (const spn of [
      'alice@evil.example',
      'alice@example.org', // a parent of the issuer's host is a domain, but not the one of Kanidm
      'alice@notidm.example.org',
      'alice@sub.idm.example.org', // a child domain does not cover the issuer's host
    ]) {
      const result = resolveOne(spn)
      expect(result.ok, spn).toBe(spn === 'alice@example.org')
    }
  })

  it('does not match a short name without an issuer, or with one that is no URL', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' })
    expect(resolveOne('alice@idm.example.org', 'not a url').ok).toBe(false)
    expect(resolveOne('alice@idm.example.org', '').ok).toBe(false)
    expect(createUsersTableResolver(db)(['alice@idm.example.org']).ok).toBe(false)
    expect(createUsersTableResolver(db, {})(['alice@idm.example.org']).ok).toBe(false)
  })

  it('prefers the user who has the whole SPN as a name', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' })
    upsertUser(db, { sub: BOB, username: 'alice@idm.example.org' })
    expect(resolveOne('alice@idm.example.org')).toEqual({
      ok: true,
      value: new Map([['alice@idm.example.org', BOB]]),
    })
  })

  it('refuses a member without a name or a domain, and an SPN with more than one @', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' })
    for (const spn of ['@idm.example.org', 'alice@', 'a@b@idm.example.org']) {
      expect(resolveOne(spn).ok, spn).toBe(false)
    }
  })

  it('still names the members nobody knows', () => {
    upsertUser(db, { sub: ALICE, username: 'alice' })
    const result = createUsersTableResolver(db, { issuer: ISSUER })([
      'alice@idm.example.org',
      'carol@idm.example.org',
    ])
    expect(!result.ok && result.failure.message).toContain('carol@idm.example.org')
    expect(!result.ok && result.failure.message).not.toContain('alice')
  })
})

describe('config', () => {
  it('clamps the interval to 1..300 and falls back to 60', () => {
    expect(clampIntervalSec('60')).toBe(60)
    expect(clampIntervalSec('300')).toBe(300)
    expect(clampIntervalSec('301')).toBe(300)
    expect(clampIntervalSec('999999')).toBe(300)
    expect(clampIntervalSec('0')).toBe(60)
    expect(clampIntervalSec('abc')).toBe(60)
    expect(clampIntervalSec('')).toBe(60)
    expect(clampIntervalSec(undefined)).toBe(60)
  })

  it('picks the group file path', () => {
    expect(groupFilePath('', 'production')).toBe('/groups/htgroup')
    expect(groupFilePath('', 'development')).toBe('.data/htgroup')
    expect(groupFilePath(' /x/y ', 'production')).toBe('/x/y')
  })
})

describe('default ports', () => {
  it('has no extra groups and audits as one log line', async () => {
    const lines: string[] = []
    const ports = createDefaultPorts((line) => lines.push(line))
    expect(await ports.listExtraGroups()).toEqual([])
    ports.audit({ action: 'a', target: 't', details: { n: 1 } })
    expect(lines).toEqual(['[group-sync] audit {"action":"a","target":"t","details":{"n":1}}'])
  })
})

describe('scheduler', () => {
  function fakeTimers() {
    const queue: { id: number; fn: () => void; ms: number }[] = []
    let next = 0
    return {
      queue,
      timers: {
        set: (fn: () => void, ms: number) => {
          const id = (next += 1)
          queue.push({ id, fn, ms })
          return id
        },
        clear: (id: unknown) => {
          const i = queue.findIndex((entry) => entry.id === id)
          if (i >= 0) queue.splice(i, 1)
        },
      },
      fire: () => queue.shift()?.fn(),
    }
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  it('runs at start, then after each interval, and never overlaps', async () => {
    const fake = fakeTimers()
    let active = 0
    let maxActive = 0
    let runs = 0
    let release: () => void = () => undefined
    const scheduler = createGroupSyncScheduler({
      run: async () => {
        runs += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((resolve) => (release = resolve))
        active -= 1
      },
      intervalMs: 60_000,
      debounceMs: 2000,
      timers: fake.timers,
    })
    scheduler.start()
    await flush()
    expect(runs).toBe(1)
    scheduler.request()
    scheduler.request()
    expect(fake.queue).toHaveLength(0) // a request during a run waits for it
    release()
    await flush()
    expect(fake.queue.map((entry) => entry.ms)).toEqual([2000]) // follow-up run
    fake.fire()
    await flush()
    expect(runs).toBe(2)
    release()
    await flush()
    expect(fake.queue.map((entry) => entry.ms)).toEqual([60_000])
    expect(maxActive).toBe(1)
  })

  it('debounces requests and survives a throwing run', async () => {
    const fake = fakeTimers()
    let runs = 0
    const scheduler = createGroupSyncScheduler({
      run: async () => {
        runs += 1
        throw new Error('boom')
      },
      intervalMs: 60_000,
      debounceMs: 2000,
      timers: fake.timers,
    })
    scheduler.start()
    await flush()
    expect(fake.queue.map((entry) => entry.ms)).toEqual([60_000])
    scheduler.request()
    scheduler.request()
    scheduler.request()
    expect(fake.queue.map((entry) => entry.ms)).toEqual([2000])
    fake.fire()
    await flush()
    expect(runs).toBe(2)
    scheduler.stop()
    expect(fake.queue).toHaveLength(0)
    scheduler.request()
    expect(fake.queue).toHaveLength(0)
  })
})

describe('the /api/me trigger', () => {
  afterEach(() => setActiveGroupSync(undefined))

  it('fires on a change of the groups only, not on the first look', () => {
    const onChange = vi.fn()
    const tracker = createGroupsTracker(onChange)
    tracker.note('u', ['a', 'b'])
    tracker.note('u', ['b', 'a'])
    expect(onChange).not.toHaveBeenCalled()
    tracker.note('u', ['a'])
    expect(onChange).toHaveBeenCalledTimes(1)
    tracker.note('other', ['a'])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a running sync, and reaches it otherwise', () => {
    expect(() => {
      requestGroupSyncRun()
      noteUserGroups('u', ['a'])
    }).not.toThrow()
    const request = vi.fn()
    const note = vi.fn()
    setActiveGroupSync({ request, note })
    requestGroupSyncRun()
    noteUserGroups('u', ['a'])
    expect(request).toHaveBeenCalledTimes(1)
    expect(note).toHaveBeenCalledWith('u', ['a'])
  })

  it('resolveMe reports the groups claim of the user', async () => {
    const db = openTestDb()
    const groupsSeen = vi.fn()
    const user = upsertUser(db, { sub: ALICE, username: 'alice' })
    await resolveMe(
      {
        db,
        adminGroup: 'calendar_admins',
        userinfo: async () => ({
          ok: true,
          profile: { sub: ALICE, username: 'alice', groups: ['web_calendar_users'] },
        }),
        warn: () => undefined,
        groupsSeen,
      },
      user,
      'token',
    )
    expect(groupsSeen).toHaveBeenCalledWith(ALICE, ['web_calendar_users'])
    db.close()
  })
})
