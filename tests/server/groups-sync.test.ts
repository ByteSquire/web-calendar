// @vitest-environment node
// The group sync with custom groups and the Kanidm group import: the file holds the app's groups,
// Kanidm's built-in groups are never imported, an app group wins a name collision, a failed import
// does not fail the run, and without a token the file is written from the app's groups alone.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKanidmClient } from '../../server/utils/group-sync/kanidm'
import type { MemberResolver } from '../../server/utils/group-sync/members'
import type { GroupSyncPorts } from '../../server/utils/group-sync/ports'
import { createGroupSyncService } from '../../server/utils/group-sync/service'
import type { ImportedGroup } from '../../server/utils/group-sync/types'

const TOKEN = 'kanidm-sync-test-token'
const ALICE = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'
const BOB = '6f9f0e2d-0000-4000-8000-000000000002'
const SPNS: Record<string, string> = { 'alice@idm.example.org': ALICE, 'bob@idm.example.org': BOB }

const entry = (name: string, member: string[], builtin = false) => ({
  attrs: { name: [name], member, class: builtin ? ['group', 'builtin'] : ['group'] },
})

let dir: string
let file: string
let logs: string[]
let listing: () => Response
let groupAnswers: Record<string, string[]>
let imported: ImportedGroup[][]
let customGroups: { name: string; members: string[] }[]
let extraGroups: string[]
let fetchSpy: ReturnType<typeof vi.fn>

const resolver: MemberResolver = async (spns) => ({
  ok: true,
  value: {
    uuids: new Map(spns.flatMap((spn) => (SPNS[spn] ? [[spn, SPNS[spn]] as const] : []))),
    pending: spns.filter((spn) => !SPNS[spn]),
  },
})

function ports(): GroupSyncPorts {
  return {
    listExtraGroups: () => extraGroups,
    audit: () => {},
    listCustomGroups: () => customGroups,
    importKanidmGroups: (groups) => {
      imported.push(groups)
    },
  }
}

function service(withToken = true) {
  const log = {
    info: (m: string) => void logs.push(`info ${m}`),
    warn: (m: string) => void logs.push(`warn ${m}`),
    error: (m: string) => void logs.push(`error ${m}`),
  }
  const client = withToken
    ? createKanidmClient({
        origin: 'https://idm.example.org',
        token: TOKEN,
        fetch: async (input, init) => {
          fetchSpy(input, init)
          const url = String(input)
          if (url.endsWith('/v1/group')) return listing()
          const name = decodeURIComponent(url.split('/').pop() ?? '')
          const members = groupAnswers[name]
          if (!members) return new Response('null')
          return new Response(JSON.stringify(entry(name, members)))
        },
      })
    : null
  return createGroupSyncService({
    client,
    resolver: client ? resolver : null,
    ports: ports(),
    log,
    file,
    adminGroup: 'calendar_admins',
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'group-sync-app-'))
  file = join(dir, 'htgroup')
  logs = []
  imported = []
  customGroups = []
  extraGroups = []
  groupAnswers = {
    calendar_admins: [`alice@idm.example.org`],
    web_calendar_users: ['alice@idm.example.org', 'bob@idm.example.org'],
  }
  listing = () =>
    new Response(
      JSON.stringify([
        entry('calendar_admins', ['alice@idm.example.org']),
        entry('web_calendar_users', ['alice@idm.example.org', 'bob@idm.example.org']),
        entry('idm_all_persons', [], true),
        entry('system_thing', [], true),
        entry('team_b', ['bob@idm.example.org']),
      ]),
    )
  fetchSpy = vi.fn()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('custom groups in the group file', () => {
  it('writes the app groups next to the Kanidm groups, with members as UUIDs', async () => {
    customGroups = [{ name: 'team_a', members: [ALICE, BOB] }]
    expect((await service().run()).ok).toBe(true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain(`team_a: ${ALICE} ${BOB}\n`)
    expect(text).toContain(`calendar_admins: ${ALICE}\n`)
    expect(text).toContain(`web_calendar_users: ${ALICE} ${BOB}\n`)
  })

  it('writes the app groups alone when there is no Kanidm token, and never calls Kanidm', async () => {
    customGroups = [{ name: 'team_a', members: [ALICE] }]
    expect(await service(false).run()).toEqual({ ok: true, outcome: 'written' })
    expect(await readFile(file, 'utf8')).toBe(`team_a: ${ALICE}\n`)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(imported).toEqual([])
  })

  it('leaves the file as it is when there is no token and no app group', async () => {
    expect(await service(false).run()).toEqual({ ok: true, outcome: 'unchanged' })
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('refuses a custom group whose member is not a valid user id (the file stays as it was)', async () => {
    customGroups = [{ name: 'team_a', members: ['not a user id'] }]
    expect((await service(false).run()).ok).toBe(false)
  })

  it('writes the ids other providers send as they are, case included', async () => {
    customGroups = [{ name: 'team_a', members: ['Alice@Example.org', 'alice@example.org'] }]
    expect((await service(false).run()).ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('team_a: Alice@Example.org alice@example.org\n')
  })
})

describe('the Kanidm group import', () => {
  it('imports every readable group except the built-ins, with members as UUIDs', async () => {
    await service().run()
    expect(imported).toHaveLength(1)
    const names = imported[0]!.map((group) => group.name).sort()
    expect(names).toEqual(['calendar_admins', 'team_b', 'web_calendar_users'])
    expect(imported[0]!.find((group) => group.name === 'team_b')!.members).toEqual([BOB])
  })

  it('skips a built-in group by its class, and by its name when the class is not visible', async () => {
    // No `class` attribute at all: only the names tell the built-in groups apart.
    const bare = (name: string, member: string[]) => ({ attrs: { name: [name], member } })
    listing = () =>
      new Response(
        JSON.stringify([
          bare('idm_hidden_builtin', []),
          bare('domain_admins', []),
          bare('team_c', ['alice@idm.example.org']),
        ]),
      )
    await service().run()
    expect(imported[0]!.map((group) => group.name)).toEqual(['team_c'])
  })

  it('keeps an app group when Kanidm has a group of the same name (the app group wins)', async () => {
    customGroups = [{ name: 'team_b', members: [ALICE] }]
    await service().run()
    expect(imported[0]!.map((group) => group.name)).not.toContain('team_b')
    expect(logs.some((line) => line.includes('"team_b" has the name of an app group'))).toBe(true)
  })

  it('does not fail the run, nor lose the file, when the Kanidm list fails', async () => {
    listing = () => new Response('oops', { status: 500 })
    const result = await service().run()
    expect(result.ok).toBe(true)
    expect(imported).toEqual([])
    expect(logs.some((line) => line.includes('the Kanidm groups were not imported'))).toBe(true)
  })

  it("fails the run when a group the file needs cannot be read (today's semantics)", async () => {
    delete groupAnswers.calendar_admins
    const result = await service().run()
    expect(result.ok).toBe(false)
  })
})

describe('members that cannot be read, and groups that are gone', () => {
  it('keeps the stored members of a group none of whose members can be read as a person', async () => {
    listing = () =>
      new Response(
        JSON.stringify([
          entry('calendar_admins', ['alice@idm.example.org']),
          entry('web_calendar_users', ['alice@idm.example.org', 'bob@idm.example.org']),
          entry('team_b', ['svc@idm.example.org']),
          entry('team_c', ['bob@idm.example.org']),
        ]),
      )
    const sync = service()
    expect((await sync.run()).ok).toBe(true)
    const last = imported.at(-1)!
    expect(last.find((group) => group.name === 'team_b')).toEqual({
      name: 'team_b',
      members: [],
      keepMembers: true,
    })
    // A group with at least one readable member is replaced as before.
    expect(last.find((group) => group.name === 'team_c')).toEqual({
      name: 'team_c',
      members: [BOB],
    })
    expect(logs.filter((line) => line.includes('team_b'))).toHaveLength(1)
    // Said once, not on every run.
    await sync.run()
    expect(logs.filter((line) => line.includes('"team_b"'))).toHaveLength(1)
  })

  it('leaves a group out of the file when a rule names it but Kanidm no longer lists it', async () => {
    extraGroups = ['team_gone']
    const result = await service().run()
    expect(result.ok).toBe(true)
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('team_gone')
    expect(text).toContain('web_calendar_users')
    expect(
      logs.some((line) => line.includes('"team_gone"') && line.includes('does not list')),
    ).toBe(true)
  })

  it('still fails when the list was not read and a named group cannot be read', async () => {
    extraGroups = ['team_gone']
    listing = () => new Response('nope', { status: 500 })
    const result = await service().run()
    expect(result.ok).toBe(false)
  })

  it('still reads the users group when it is missing from the list', async () => {
    listing = () => new Response(JSON.stringify([entry('team_b', ['bob@idm.example.org'])]))
    expect((await service().run()).ok).toBe(true)
    expect(await readFile(file, 'utf8')).toContain('web_calendar_users')
  })
})
