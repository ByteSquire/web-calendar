import { createFetch } from 'ofetch'
import { describe, expect, it, vi } from 'vitest'
import type { ExternalAccountResult } from '../shared/types/external'
import { createExternalApi } from '../app/utils/external/api'
import { describeExternalSaveError } from '../app/utils/external/api-errors'
import { enterPassword, keepResult } from '../app/utils/external/credentials'
import { createSealStore } from '../app/utils/external/seals'
import { SEALED, account } from './external-helpers'

// The typed client of /api/external-accounts, the words for its errors, and what is done with a
// sealed credential that comes back.

interface Call {
  method: string
  path: string
  body: unknown
}

function backend(answer: (call: Call) => { status: number; json?: unknown }) {
  const calls: Call[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : (input as Request).url,
      'http://app.test',
    )
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const { status, json } = answer(call)
    return new Response(status === 204 ? null : json === undefined ? null : JSON.stringify(json), {
      status,
      headers: json === undefined ? {} : { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const api = createExternalApi(createFetch({ fetch: fetchFn }) as unknown as typeof $fetch)
  return { api, calls }
}

const apiError = (status: number, message: string, data?: unknown) => ({
  status,
  json: { error: true, statusCode: status, statusMessage: 'Error', message, data },
})

const result = (extra: Partial<ExternalAccountResult> = {}): ExternalAccountResult => ({
  account: account(3, { authMode: 'basic', username: 'me' }),
  sealed: SEALED,
  ...extra,
})

describe('the routes', () => {
  it('lists, creates, changes, seals again and deletes', async () => {
    const { api, calls } = backend(({ method, path }) => {
      if (method === 'GET') return { status: 200, json: { accounts: [], loginsEnabled: true } }
      if (method === 'DELETE') return { status: 204 }
      return {
        status: path.endsWith('/credential') || method === 'PUT' ? 200 : 201,
        json: result(),
      }
    })
    await expect(api.list()).resolves.toEqual({ accounts: [], loginsEnabled: true })
    await api.create({
      name: 'A',
      url: 'https://dav.example.org/',
      authMode: 'basic',
      username: 'me',
      password: 'pw',
    })
    await api.update(3, { name: 'B', password: 'pw2' })
    await api.setCredential(3, 'pw3')
    await expect(api.remove(3)).resolves.toBeUndefined()

    expect(calls).toEqual([
      { method: 'GET', path: '/api/external-accounts', body: undefined },
      {
        method: 'POST',
        path: '/api/external-accounts',
        body: {
          name: 'A',
          url: 'https://dav.example.org/',
          authMode: 'basic',
          username: 'me',
          password: 'pw',
        },
      },
      { method: 'PUT', path: '/api/external-accounts/3', body: { name: 'B', password: 'pw2' } },
      { method: 'POST', path: '/api/external-accounts/3/credential', body: { password: 'pw3' } },
      { method: 'DELETE', path: '/api/external-accounts/3', body: undefined },
    ])
  })
})

describe('the words for what the server rejected', () => {
  const words = (error: unknown) => describeExternalSaveError(error, 'add the account')

  async function failure(answer: ReturnType<typeof apiError>) {
    const { api } = backend(() => answer)
    try {
      await api.create({ name: 'A', url: 'https://x/', authMode: 'none' })
    } catch (error) {
      return words(error)
    }
    throw new Error('expected a failure')
  }

  it('names the limit', async () => {
    const found = await failure(apiError(409, 'At most 10', { code: 'limit_reached' }))
    expect(found.alert).toContain('limit of 10 external accounts')
    expect(found.byField).toEqual({})
  })

  it('says logins are not enabled', async () => {
    const found = await failure(
      apiError(400, 'Accounts with a login are not available', {
        code: 'logins_disabled',
        fields: [],
      }),
    )
    expect(found.alert).toContain('administrator has not enabled logins')
  })

  it('puts a host that is not allowed, and a bad address, under the address', async () => {
    const hostNotAllowed = await failure(
      apiError(400, 'The host is not allowed', {
        code: 'host_not_allowed',
        fields: [{ field: 'url', message: 'is not allowed' }],
      }),
    )
    expect(hostNotAllowed.byField.url).toContain('administrator has not allowed this server')
    expect(hostNotAllowed.alert).toBeUndefined()

    const invalid = await failure(apiError(400, 'bad', { code: 'invalid_url', fields: [] }))
    expect(invalid.byField.url).toContain('cannot be used')
  })

  it('puts a missing password under the password', async () => {
    const found = await failure(
      apiError(400, 'The password is needed', {
        code: 'credential_required',
        fields: [{ field: 'password', message: 'is required for this change' }],
      }),
    )
    expect(found.byField.password).toBe('Enter the password of the account.')
  })

  it('puts field problems under their fields and the rest in an alert', async () => {
    const found = await failure(
      apiError(400, 'The request is not valid', {
        fields: [
          { field: 'name', message: 'must not be empty' },
          { field: 'username', message: 'must not contain a colon' },
          { field: 'authMode', message: 'must be none or basic' },
        ],
      }),
    )
    expect(found.byField).toEqual({
      name: 'The name must not be empty.',
      username: 'The user name must not contain a colon.',
    })
    expect(found.alert).toBe('Could not add the account: authMode must be none or basic.')
  })

  it('words a server error, a lost session and a lost connection', async () => {
    expect((await failure(apiError(500, 'boom'))).alert).toContain(
      'answered with an error (HTTP 500)',
    )
    expect((await failure(apiError(401, 'Unauthorized'))).alert).toContain('signed out')
    const down = createExternalApi(
      createFetch({
        fetch: (async () => {
          throw new TypeError('Failed to fetch')
        }) as typeof fetch,
      }) as unknown as typeof $fetch,
    )
    try {
      await down.list()
    } catch (error) {
      expect(words(error).alert).toContain('could not be reached')
    }
  })

  it('does not put the request into the words', async () => {
    const { api } = backend(() => apiError(500, 'boom'))
    let found = ''
    try {
      await api.create({
        name: 'A',
        url: 'https://x/',
        authMode: 'basic',
        username: 'me',
        password: 'hunter2-secret',
      })
    } catch (error) {
      found = JSON.stringify(words(error))
    }
    expect(found).not.toContain('hunter2-secret')
  })
})

describe('keeping a sealed credential', () => {
  const fresh = () => createSealStore({ userSub: () => 'sub-1', storage: () => null })

  it('keeps the sealed text of an account with a login, and says if it is on the device', () => {
    const seals = fresh()
    expect(keepResult(seals, result(), false)).toBe(false)
    expect(seals.get(3)).toBe(SEALED)
  })

  it('keeps what it has when an update brought no seal (a rename)', () => {
    const seals = fresh()
    seals.set(3, 'old-seal', false)
    keepResult(seals, result({ sealed: null }), false)
    expect(seals.get(3)).toBe('old-seal')
  })

  it('forgets it when the account no longer has a login', () => {
    const seals = fresh()
    seals.set(3, 'old-seal', false)
    keepResult(seals, { account: account(3, { authMode: 'none' }), sealed: null }, false)
    expect(seals.get(3)).toBeNull()
  })

  it('has nothing to keep when there was nothing and the call brought nothing', () => {
    const seals = fresh()
    expect(keepResult(seals, result({ sealed: null }), true)).toBe(false)
    expect(seals.get(3)).toBeNull()
  })

  it('enterPassword seals the password on the server and keeps only the sealed text', async () => {
    const seals = fresh()
    const setCredential = vi.fn(async () => result())
    const outcome = await enterPassword({ api: { setCredential }, seals }, 3, 'hunter2', false)
    expect(outcome).toEqual({ ok: true, remembered: false })
    expect(setCredential).toHaveBeenCalledWith(3, 'hunter2')
    expect(seals.get(3)).toBe(SEALED)
  })

  it('enterPassword words a failure and never throws or repeats the request', async () => {
    const seals = fresh()
    const { api } = backend(() => apiError(500, 'boom'))
    const outcome = await enterPassword({ api, seals }, 3, 'hunter2-secret', true)
    expect(outcome.ok).toBe(false)
    expect(JSON.stringify(outcome)).not.toContain('hunter2-secret')
    expect(seals.has(3)).toBe(false)
  })

  it('enterPassword does not accept an answer without a credential for an account with a login', async () => {
    const seals = fresh()
    const outcome = await enterPassword(
      { api: { setCredential: async () => result({ sealed: null }) }, seals },
      3,
      'pw',
      false,
    )
    expect(outcome).toMatchObject({ ok: false })
    expect(seals.has(3)).toBe(false)
  })
})
