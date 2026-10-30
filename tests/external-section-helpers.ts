// Shared setup of the component tests of the external accounts (settings section, password dialog,
// the problems in the sidebar): a fake of /api/external-accounts that answers like the server
// (server/api/external-accounts/**, server/utils/external/errors.ts), and the module mock that
// hands the components a real API client and seal store on top of it.
import { createFetch } from 'ofetch'
import type {
  ExternalAccount,
  ExternalAccountResult,
  ExternalAccountUpdate,
} from '../shared/types/external'
import { createExternalApi } from '../app/utils/external/api'
import { createSealStore } from '../app/utils/external/seals'
import type { ExternalSource } from '../app/utils/external/source'
import { SEALED, account } from './external-helpers'
import { reply } from './settings-helpers'

type Reply = ReturnType<(typeof reply)['json']>

export interface Call {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

/** The error bodies of the external-account routes: a code next to the usual fields. */
export const external = {
  code: (code: string, message: string, fields: { field: string; message: string }[] = []) =>
    reply.error(400, message, { code, fields }),
}

export class ExternalBackend {
  accounts: ExternalAccount[] = []
  loginsEnabled = true
  calls: Call[] = []
  override: ((call: Call) => Reply | undefined) | null = null
  /** The sealed text the next create, update with a password or credential call returns. */
  nextSealed = SEALED
  private nextId = 100

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input as Request).url,
      'http://app.test',
    )
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    this.calls.push(call)
    const answer = this.override?.(call) ?? this.answer(call)
    const headers = new Headers()
    if (answer.json !== undefined) headers.set('content-type', 'application/json')
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.json ?? null), {
      status: answer.status,
      headers,
    })
  }

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter((call) => call.method === method && call.path === path)
  }

  private result(target: ExternalAccount, sealed: string | null): Reply {
    return reply.json({ account: target, sealed } satisfies ExternalAccountResult)
  }

  private answer({ method, path, body }: Call): Reply {
    const fields = (body ?? {}) as Record<string, unknown>
    const one = /^\/api\/external-accounts\/(\d+)(\/credential)?$/.exec(path)

    if (method === 'GET' && path === '/api/external-accounts') {
      return reply.json({ accounts: this.accounts, loginsEnabled: this.loginsEnabled })
    }
    if (method === 'POST' && path === '/api/external-accounts') {
      const login = fields.authMode === 'basic'
      const created = account(this.nextId++, {
        name: String(fields.name),
        url: String(fields.url),
        authMode: login ? 'basic' : 'none',
        username: login ? String(fields.username) : null,
        color: (fields.color as string | null) ?? null,
      })
      this.accounts = [...this.accounts, created]
      return {
        status: 201,
        json: { account: created, sealed: login ? this.nextSealed : null },
      }
    }
    if (one) {
      const id = Number(one[1])
      const current = this.accounts.find((item) => item.id === id)
      if (!current) return reply.error(404, 'Not found')
      if (method === 'POST' && one[2]) {
        return this.result(current, this.nextSealed)
      }
      if (method === 'PUT') {
        const change = fields as ExternalAccountUpdate
        const saved: ExternalAccount = {
          ...current,
          ...change,
          username: change.authMode === 'none' ? null : (change.username ?? current.username),
          updatedAt: '2026-10-02T08:00:00.000Z',
        } as ExternalAccount
        this.accounts = this.accounts.map((item) => (item.id === id ? saved : item))
        const sealed = saved.authMode === 'basic' && change.password ? this.nextSealed : null
        return this.result(saved, sealed)
      }
      if (method === 'DELETE') {
        this.accounts = this.accounts.filter((item) => item.id !== id)
        return reply.empty()
      }
    }
    return reply.error(404, 'Not found')
  }
}

/** What `useExternalAccess()` hands the components in these tests. */
export function newAccess(backend: ExternalBackend, storage: Storage | null = null) {
  const seals = createSealStore({ userSub: () => 'sub-1', storage: () => storage })
  const source: ExternalSource = {
    listAccounts: async () => ({ accounts: backend.accounts, loginsEnabled: true }),
    listCalendars: async () => [],
    read: async () => [],
  }
  return {
    api: createExternalApi(createFetch({ fetch: backend.fetch }) as unknown as typeof $fetch),
    seals,
    source,
  }
}

/** A `localStorage` stand-in for the "remember on this device" tests. */
export class MemoryStorage implements Storage {
  data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  clear() {
    this.data.clear()
  }
  [name: string]: unknown
}
