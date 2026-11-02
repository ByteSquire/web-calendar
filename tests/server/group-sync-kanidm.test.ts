// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createKanidmClient,
  kanidmOrigin,
  type KanidmClientOptions,
} from '../../server/utils/group-sync/kanidm'

const TOKEN = 'sync-secret-token-123'
const group = (name: string, member?: string[]) =>
  JSON.stringify({ attrs: { class: ['group'], name: [name], ...(member ? { member } : {}) } })

function client(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  extra: Partial<KanidmClientOptions> = {},
) {
  const calls: { url: string; init: RequestInit }[] = []
  const api = createKanidmClient({
    origin: 'https://idm.example.org',
    token: TOKEN,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} })
      return respond(String(input), init ?? {})
    },
    ...extra,
  })
  return { api, calls }
}

describe('kanidmOrigin', () => {
  it('is the origin of the issuer', () => {
    expect(kanidmOrigin('https://idm.example.org/oauth2/openid/web-calendar')).toBe(
      'https://idm.example.org',
    )
    expect(kanidmOrigin('not a url')).toBeNull()
    expect(kanidmOrigin('ftp://idm.example.org')).toBeNull()
  })
})

describe('createKanidmClient.readGroup', () => {
  it('reads the members with the bearer token', async () => {
    const { api, calls } = client(
      () => new Response(group('calendar_admins', ['alice@idm.example.org'])),
    )
    expect(await api.readGroup('calendar_admins')).toEqual({
      ok: true,
      value: { name: 'calendar_admins', members: ['alice@idm.example.org'] },
    })
    expect(calls[0]?.url).toBe('https://idm.example.org/v1/group/calendar_admins')
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('reads a group without a member attribute as empty', async () => {
    const { api } = client(() => new Response(group('g')))
    expect(await api.readGroup('g')).toEqual({ ok: true, value: { name: 'g', members: [] } })
  })

  it('treats null as a failure, never as an empty group', async () => {
    const { api } = client(() => new Response('null'))
    const result = await api.readGroup('g')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('null-answer')
  })

  it('raises unauthorized for 401 and 403', async () => {
    for (const status of [401, 403]) {
      const { api } = client(() => new Response('denied', { status }))
      const result = await api.readGroup('g')
      expect(!result.ok && result.failure.kind).toBe('unauthorized')
    }
  })

  it.each([
    ['not JSON', '{'],
    ['no attrs', '{}'],
    ['another group', group('other')],
    ['members not strings', JSON.stringify({ attrs: { name: ['g'], member: [1] } })],
    ['a member with a space', JSON.stringify({ attrs: { name: ['g'], member: ['a b'] } })],
  ])('rejects a malformed answer: %s', async (_label, body) => {
    const { api } = client(() => new Response(body))
    const result = await api.readGroup('g')
    expect(!result.ok && result.failure.kind).toBe('malformed')
  })

  it('fails on other HTTP statuses and on an answer over the size cap', async () => {
    const server = client(() => new Response('x', { status: 500 }))
    const a = await server.api.readGroup('g')
    expect(!a.ok && a.failure.kind).toBe('http-error')
    const big = client(() => new Response(group('g', ['a@b'.padEnd(500, 'x')])), { maxBytes: 100 })
    const b = await big.api.readGroup('g')
    expect(!b.ok && b.failure.kind).toBe('too-large')
  })

  it('times out', async () => {
    const { api } = client(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
      { timeoutMs: 20 },
    )
    const result = await api.readGroup('g')
    expect(!result.ok && result.failure.kind).toBe('timeout')
  })

  it('never puts the token into a failure message', async () => {
    const fetchers: (() => Response | Promise<Response>)[] = [
      () => {
        throw Object.assign(new TypeError(`fetch failed for Bearer ${TOKEN}`), {
          cause: { code: TOKEN },
        })
      },
      () => new Response(`bad ${TOKEN}`, { status: 403 }),
      () => new Response(`bad ${TOKEN}`, { status: 500 }),
      () => new Response(`{${TOKEN}`),
    ]
    for (const respond of fetchers) {
      const result = await client(respond).api.readGroup('g')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(JSON.stringify(result.failure)).not.toContain(TOKEN)
    }
  })
})

describe('createKanidmClient.readPersonUuid', () => {
  const ALICE = '189c6a24-f9cb-437b-8f58-b5cc8d7f909e'

  it('reads the uuid attribute of the person by SPN, lower-case, with the bearer token', async () => {
    const { api, calls } = client(() => new Response(JSON.stringify([ALICE.toUpperCase()])))
    expect(await api.readPersonUuid('alice@idm.example.org')).toEqual({ ok: true, value: ALICE })
    expect(calls[0]?.url).toBe(
      'https://idm.example.org/v1/person/alice%40idm.example.org/_attr/uuid',
    )
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]?.init.redirect).toBe('error')
  })

  it('answers null when Kanidm does: not a person, or not readable by the token', async () => {
    const { api } = client(() => new Response('null'))
    expect(await api.readPersonUuid('sync@idm.example.org')).toEqual({ ok: true, value: null })
  })

  it('encodes the SPN, so it cannot leave the person path', async () => {
    const { api, calls } = client(() => new Response('null'))
    await api.readPersonUuid('../group/x?y#z')
    expect(calls[0]?.url).toBe(
      'https://idm.example.org/v1/person/..%2Fgroup%2Fx%3Fy%23z/_attr/uuid',
    )
  })

  it.each([
    ['not a list', JSON.stringify({ uuid: ALICE })],
    ['two values', JSON.stringify([ALICE, ALICE])],
    ['no value', '[]'],
    ['not a UUID', JSON.stringify(['alice'])],
    ['not JSON', '<html>'],
  ])('fails on a malformed answer: %s', async (_, body) => {
    const { api } = client(() => new Response(body))
    const result = await api.readPersonUuid('alice@idm.example.org')
    expect(!result.ok && result.failure.kind).toBe('malformed')
  })

  it('reports a refused token as unauthorized and keeps the token out of messages', async () => {
    const { api } = client(() => new Response('', { status: 403 }))
    const result = await api.readPersonUuid('alice@idm.example.org')
    expect(!result.ok && result.failure.kind).toBe('unauthorized')
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('reports a network failure without the token', async () => {
    const { api } = client(() => {
      throw new TypeError(`fetch failed ${TOKEN}`, { cause: { code: 'ECONNREFUSED' } })
    })
    const result = await api.readPersonUuid('alice@idm.example.org')
    expect(!result.ok && result.failure.kind).toBe('network')
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})
