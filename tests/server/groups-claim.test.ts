// @vitest-environment node
// The groups claim parser: what each provider sends (plan 8.3), the edge cases of data from
// outside, and the promise that every name that comes out passes the group-file name rule.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MAX_CLAIM_GROUPS,
  claimIsOverage,
  parseGroupsClaim,
  parseIgnoreList,
  sanitiseGroupName,
} from '../../server/utils/groups/claim'
import { isGroupName } from '../../server/utils/groups/htgroup'
import { openTestDb } from './api-fixtures'

const IGNORE = parseIgnoreList('idm_*,system_*,domain_*')
const parse = (value: unknown, ignore: readonly string[] = IGNORE) =>
  parseGroupsClaim(value, { ignore })
/** The groups of a claim, as `key => name` pairs; fails if the claim is absent. */
function pairs(value: unknown, ignore: readonly string[] = IGNORE): [string, string][] {
  const parsed = parse(value, ignore)
  if (parsed.absent) throw new Error('the claim was read as absent')
  return parsed.groups.map((group) => [group.key, group.name])
}

describe('what providers send', () => {
  it('reads the real Kanidm claim (uuid and spn pairs) and hides the built-in groups', () => {
    const fixture = JSON.parse(
      readFileSync(fileURLToPath(new URL('./auth-kanidm-fixture.json', import.meta.url)), 'utf8'),
    ) as { idToken: string }
    const payload = JSON.parse(Buffer.from(fixture.idToken.split('.')[1]!, 'base64url').toString())
    expect(payload.groups).toHaveLength(10)
    expect(pairs(payload.groups)).toEqual([
      ['3315c15e-4ff7-459a-97de-d176279d4154', 'web_calendar_users'],
      ['a12fec6b-b6d8-4973-8b6f-42dd669f9aca', 'calendar_admins'],
    ])
  })

  it('reads Kanidm groups with groups_name added: the plain name wins over the spn', () => {
    expect(
      pairs([
        '3315c15e-4ff7-459a-97de-d176279d4154',
        'staff@idm.example.org',
        'staff',
        'a12fec6b-b6d8-4973-8b6f-42dd669f9aca',
        'ops@idm.example.org',
        'ops',
      ]),
    ).toEqual([
      ['3315c15e-4ff7-459a-97de-d176279d4154', 'staff'],
      ['a12fec6b-b6d8-4973-8b6f-42dd669f9aca', 'ops'],
    ])
  })

  it('reads the groups_name scope alone (names only) and the spn-only scope', () => {
    expect(pairs(['staff', 'ops'])).toEqual([
      ['staff', 'staff'],
      ['ops', 'ops'],
    ])
    expect(pairs(['staff@idm.example.org', 'ops@idm.example.org'])).toEqual([
      ['staff@idm.example.org', 'staff'],
      ['ops@idm.example.org', 'ops'],
    ])
  })

  it('reads Keycloak paths: the key is the path, the name the segments joined by dots', () => {
    expect(pairs(['/calendar_admins', '/team/ops', '/a/b/c'])).toEqual([
      ['/calendar_admins', 'calendar_admins'],
      ['/team/ops', 'team.ops'],
      ['/a/b/c', 'a.b.c'],
    ])
  })

  it('reads Keycloak names without the full path', () => {
    expect(pairs(['calendar_admins', 'ops'])).toEqual([
      ['calendar_admins', 'calendar_admins'],
      ['ops', 'ops'],
    ])
  })

  it('reads Entra object ids: a lone id names the group after itself', () => {
    const a = '0a1b2c3d-1111-4222-8333-444455556666'
    const b = '9F8E7D6C-1111-4222-8333-444455556666'
    expect(pairs([a, b])).toEqual([
      [a, a],
      // The key is kept as sent, even in capitals.
      [b, b],
    ])
  })

  it('reads names with blanks (Authentik, Okta) and makes them file-safe', () => {
    expect(pairs(['authentik Admins', 'Everyone', 'Team A/B'])).toEqual([
      ['authentik Admins', 'authentik_Admins'],
      ['Everyone', 'Everyone'],
      ['Team A/B', 'Team_A_B'],
    ])
  })

  it('reads the keys of an object (Zitadel roles)', () => {
    expect(
      pairs({ admin: { '123': 'acme.example.org' }, reader: { '123': 'acme.example.org' } }),
    ).toEqual([
      ['admin', 'admin'],
      ['reader', 'reader'],
    ])
  })

  it('reads one string as one group (a provider that sends a single value)', () => {
    expect(pairs('staff')).toEqual([['staff', 'staff']])
  })
})

describe('absent, empty and malformed', () => {
  it.each([undefined, null, 42, true, Symbol.for('x')])('treats %s as an absent claim', (value) => {
    expect(parse(value)).toEqual({ absent: true })
  })

  it('treats an empty array as a claim: the person is in no group', () => {
    expect(parse([])).toEqual({ absent: false, groups: [], warnings: [], truncated: false })
    expect(parse({})).toEqual({ absent: false, groups: [], warnings: [], truncated: false })
  })

  it('drops entries that are not text and says how many', () => {
    const parsed = parse(['staff', 1, null, { a: 1 }, ['x'], 'ops'])
    expect(parsed).toMatchObject({ absent: false })
    if (parsed.absent) return
    expect(parsed.groups.map((g) => g.name)).toEqual(['staff', 'ops'])
    expect(parsed.warnings).toEqual(['4 entries of the groups claim are not text'])
  })

  it('skips empty entries and entries over 255 characters, with a warning each time', () => {
    const parsed = parse(['', 'x'.repeat(256), 'y'.repeat(255)])
    if (parsed.absent) throw new Error('absent')
    expect(parsed.groups.map((g) => g.key)).toEqual(['y'.repeat(255)])
    // The longest key is cut to a 64-character name.
    expect(parsed.groups[0]!.name).toHaveLength(64)
    expect(parsed.warnings).toHaveLength(2)
  })

  it('counts a key that appears twice once', () => {
    expect(pairs(['staff', 'staff', '/ops', '/ops'])).toEqual([
      ['staff', 'staff'],
      ['/ops', 'ops'],
    ])
  })

  it('skips a group whose name is nothing after cleaning, and says so without echoing it all', () => {
    const parsed = parse(['///', '@example.org', '---', 'ok', 'ü'.repeat(100)])
    if (parsed.absent) throw new Error('absent')
    expect(parsed.groups.map((g) => g.key)).toEqual(['ok'])
    expect(parsed.warnings).toHaveLength(4)
    expect(parsed.warnings.join('\n').length).toBeLessThan(400)
  })

  it('takes entries after an id as its names only in the shape of Kanidm: an SPN, then a short name', () => {
    const id = '3315c15e-4ff7-459a-97de-d176279d4154'
    const other = 'a12fec6b-b6d8-4973-8b6f-42dd669f9aca'
    // id + SPN, id + SPN + short name, and the short name wins over the SPN's local part.
    expect(pairs([id, 'ops@idm.example.org', other, 'x@idm.example.org', 'finance'])).toEqual([
      [id, 'ops'],
      [other, 'finance'],
    ])
  })

  it('lets an id stand alone when no SPN follows, and reads what comes after it on its own', () => {
    const id = '3315c15e-4ff7-459a-97de-d176279d4154'
    // A plain-name provider with a group called like an id: nothing after it is swallowed.
    expect(pairs(['plain1', id, 'finance', '/x/y', 'plain2'])).toEqual([
      ['plain1', 'plain1'],
      [id, id],
      ['finance', 'finance'],
      ['/x/y', 'x.y'],
      ['plain2', 'plain2'],
    ])
    // The same for a lone id followed by a name.
    expect(pairs([id, 'plain'])).toEqual([
      [id, id],
      ['plain', 'plain'],
    ])
  })

  it('does not take a path, a second id or a malformed SPN for the names of an id', () => {
    const id = '3315c15e-4ff7-459a-97de-d176279d4154'
    const other = 'a12fec6b-b6d8-4973-8b6f-42dd669f9aca'
    expect(pairs([id, '/team/ops'])).toEqual([
      [id, id],
      ['/team/ops', 'team.ops'],
    ])
    expect(pairs([id, other])).toEqual([
      [id, id],
      [other, other],
    ])
    for (const bad of ['@idm.example.org', 'ops@', 'a@b@c']) {
      expect(pairs([id, bad]).map(([key]) => key)[0]).toBe(id)
      expect(pairs([id, bad])[0]![1]).toBe(id)
    }
    // After an SPN a path or a second SPN is not a short name either.
    expect(pairs([id, 'ops@idm.example.org', '/team/ops'])).toEqual([
      [id, 'ops'],
      ['/team/ops', 'team.ops'],
    ])
  })

  it('takes a name that looks like a uuid for the key of a group, as it is', () => {
    const odd = '3315c15e-4ff7-459a-97de-d176279d4154'
    expect(pairs([odd])).toEqual([[odd, odd]])
  })
})

describe('the ignore list', () => {
  it('hides names by exact match or prefix, without regard to case, after cleaning', () => {
    const claim = ['idm_admins', 'IDM_people', 'system_x', 'domain_y', 'staff', 'idm', 'a b']
    expect(pairs(claim).map(([, name]) => name)).toEqual(['staff', 'idm', 'a_b'])
    expect(pairs(claim, parseIgnoreList('staff, a_b')).map(([, n]) => n)).toEqual([
      'idm_admins',
      'IDM_people',
      'system_x',
      'domain_y',
      'idm',
    ])
    expect(pairs(claim, [])).toHaveLength(7)
  })

  it('treats a prefix pattern as a prefix only, not as a pattern', () => {
    expect(pairs(['staff_idm_x'], parseIgnoreList('idm_*'))).toHaveLength(1)
    expect(parseIgnoreList(' idm_* , ,staff ')).toEqual(['idm_*', 'staff'])
    expect(parseIgnoreList(undefined)).toEqual([])
  })

  it('applies to the name made from the spn of a uuid group', () => {
    expect(
      pairs(['00000000-0000-0000-0000-000000000035', 'idm_all_persons@idm.localhost']),
    ).toEqual([])
  })
})

describe('limits', () => {
  it('keeps the first 200 groups and says the rest was skipped', () => {
    const claim = Array.from({ length: MAX_CLAIM_GROUPS + 20 }, (_, i) => `g${i}`)
    const parsed = parse(claim)
    if (parsed.absent) throw new Error('absent')
    expect(parsed.groups).toHaveLength(MAX_CLAIM_GROUPS)
    expect(parsed.groups[0]!.key).toBe('g0')
    expect(parsed.groups.at(-1)!.key).toBe(`g${MAX_CLAIM_GROUPS - 1}`)
    expect(parsed.warnings).toHaveLength(1)
    // The import must know that it sees a part: it may add, but not remove.
    expect(parsed.truncated).toBe(true)
  })

  it('does not count ignored groups against the limit', () => {
    const claim = [
      ...Array.from({ length: 50 }, (_, i) => `idm_${i}`),
      ...Array.from({ length: MAX_CLAIM_GROUPS }, (_, i) => `g${i}`),
    ]
    const parsed = parse(claim)
    if (parsed.absent) throw new Error('absent')
    expect(parsed.groups).toHaveLength(MAX_CLAIM_GROUPS)
    expect(parsed.warnings).toEqual([])
    expect(parsed.truncated).toBe(false)
  })
})

describe('names', () => {
  it.each([
    ['staff', 'staff'],
    ['Team.Ops-1_x', 'Team.Ops-1_x'],
    ['  staff  ', 'staff'],
    ['__x', 'x'],
    ['.hidden', 'hidden'],
    ['a  b\tc', 'a_b_c'],
    ['a:b', 'a_b'],
    ['Café', 'Caf_'],
    ['ü', ''],
    ['', ''],
    ['x'.repeat(100), 'x'.repeat(64)],
  ])('makes %j into %j', (text, expected) => {
    expect(sanitiseGroupName(text)).toBe(expected)
  })

  it('never produces a name the group file or the candidates table would refuse (random input)', () => {
    // A small deterministic generator: the same cases on every run.
    let state = 123456789
    const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff)
    const alphabet = [
      'a',
      'Z',
      '0',
      '9',
      '_',
      '.',
      '-',
      ' ',
      '/',
      '@',
      ':',
      'é',
      '\u0000',
      '\n',
      '😀',
      '*',
    ]
    const db = openTestDb()
    try {
      const insert = db.prepare(
        'INSERT INTO oidc_group_candidates (external_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING',
      )
      for (let i = 0; i < 2000; i += 1) {
        const length = next() % 40
        let text = ''
        for (let j = 0; j < length; j += 1) text += alphabet[next() % alphabet.length]
        const parsed = parse([text], [])
        if (parsed.absent) throw new Error('absent')
        for (const group of parsed.groups) {
          expect(isGroupName(group.name)).toBe(true)
          expect(group.key.length).toBeGreaterThanOrEqual(1)
          expect(group.key.length).toBeLessThanOrEqual(255)
          // The database's own CHECK agrees (the same shape, written in GLOB).
          insert.run(group.key, group.name)
        }
      }
    } finally {
      db.close()
    }
  })
})

describe('the overage of Entra', () => {
  it('sees the pointer Entra leaves instead of the claim when there are too many groups', () => {
    const payload = {
      _claim_names: { groups: 'src1' },
      _claim_sources: {
        src1: { endpoint: 'https://graph.windows.net/x/users/y/getMemberObjects' },
      },
    }
    expect(claimIsOverage(payload, 'groups')).toBe(true)
    expect(claimIsOverage(payload, 'roles')).toBe(false)
  })

  it('does not see one where there is none, or in a claim that is not an object', () => {
    expect(claimIsOverage({}, 'groups')).toBe(false)
    expect(claimIsOverage({ _claim_names: null }, 'groups')).toBe(false)
    expect(claimIsOverage({ _claim_names: ['groups'] }, 'groups')).toBe(false)
    expect(claimIsOverage({ _claim_names: 'groups' }, 'groups')).toBe(false)
    // An inherited property is not a claim name.
    expect(claimIsOverage({ _claim_names: {} }, 'toString')).toBe(false)
  })
})
