// Shared setup of the settings component tests: a fake backend that answers like the real API
// (server/api/app-tokens/**, ical-subscriptions/**, me.get.ts), including its error bodies, and
// small DOM helpers. `useAuthFetch` is replaced by a real ofetch instance on top of the fake
// `fetch`, so the tests go through ofetch's own error handling (FetchError, retries) as the app does.
import { createFetch } from 'ofetch'
import type {
  CreatedToken,
  MeResponse,
  Subscription,
  TokenListItem,
} from '../app/utils/settings/types'

export interface RecordedCall {
  method: string
  path: string
  body: unknown
}

type Reply = { status: number; json?: unknown; text?: string }

/** Replies the real server gives, h3-shaped. */
export const reply = {
  json: (json: unknown, status = 200): Reply => ({ status, json }),
  empty: (): Reply => ({ status: 204 }),
  error: (status: number, message: string, data?: unknown): Reply => ({
    status,
    json: { error: true, statusCode: status, statusMessage: 'Error', message, data },
  }),
  invalid: (...fields: { field: string; message: string }[]): Reply =>
    reply.error(400, 'The request is not valid', { fields }),
}

export function token(id: number, extra: Partial<TokenListItem> = {}): TokenListItem {
  return {
    id,
    label: `Token ${id}`,
    createdAt: '2026-09-01T08:00:00.000Z',
    expiresAt: '2027-09-01T08:00:00.000Z',
    lastUsedAt: null,
    expired: false,
    ...extra,
  }
}

export function subscription(id: number, extra: Partial<Subscription> = {}): Subscription {
  return {
    id,
    ref: `ics:${id}`,
    name: `Calendar ${id}`,
    url: `https://example.org/calendar-${id}.ics`,
    color: '#1d4ed8',
    shared: false,
    ...extra,
  }
}

export const ME: MeResponse = {
  id: 1,
  sub: '189c6a24-f9cb-437b-8f58-b5cc8d7f909e',
  username: 'alice',
  name: 'Alice Example',
  email: 'alice@example.test',
  isAdmin: false,
  timeZone: null,
}

/**
 * The API as a function of the request. State lives here (tokens, subscriptions); `override`
 * answers first, for one-off failures: return a reply to take over, nothing to fall through.
 */
export class FakeBackend {
  me: MeResponse = { ...ME }
  tokens: TokenListItem[] = []
  limit = 10
  subscriptions: Subscription[] = []
  /** The .ics text of GET /data per subscription id; a Reply makes it an error. */
  documents = new Map<number, string | Reply>()
  calls: RecordedCall[] = []
  override: ((call: RecordedCall) => Reply | Promise<Reply> | undefined) | null = null
  /** The secret the next POST /api/app-tokens returns. */
  nextSecret = 'wcal_test_secret_0123456789abcdef'
  private nextId = 100

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : (input as Request).url,
      'http://app.test',
    )
    const call: RecordedCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    this.calls.push(call)
    const taken = this.override ? await this.override(call) : undefined
    const answer = taken ?? this.answer(call)
    const headers = new Headers()
    let body: string | null = null
    if (answer.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(answer.json)
    } else if (answer.text !== undefined) {
      headers.set('content-type', 'text/calendar; charset=utf-8')
      body = answer.text
    }
    // A 204 must not have a body.
    return new Response(answer.status === 204 ? null : body, { status: answer.status, headers })
  }

  callsTo(method: string, path: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path)
  }

  private answer({ method, path, body }: RecordedCall): Reply {
    const subscriptionId = /^\/api\/ical-subscriptions\/(\d+)(\/data)?$/.exec(path)
    const tokenId = /^\/api\/app-tokens\/(\d+)$/.exec(path)
    const fields = (body ?? {}) as Record<string, unknown>

    if (method === 'GET' && path === '/api/me') return reply.json(this.me)

    if (method === 'GET' && path === '/api/app-tokens') {
      return reply.json({ tokens: this.tokens, limit: this.limit })
    }
    if (method === 'POST' && path === '/api/app-tokens') {
      const label = typeof fields.label === 'string' ? fields.label.trim() : ''
      if (label === '') return reply.invalid({ field: 'label', message: 'must not be empty' })
      if (this.tokens.filter((item) => !item.expired).length >= this.limit) {
        return reply.error(409, `At most ${this.limit} app tokens are allowed per user`, {
          code: 'limit_reached',
        })
      }
      const created: CreatedToken = {
        id: this.nextId++,
        label,
        token: this.nextSecret,
        expiresAt: '2027-10-30T12:00:00.000Z',
      }
      this.tokens = [token(created.id, { label, expiresAt: created.expiresAt }), ...this.tokens]
      return reply.json(created, 201)
    }
    if (method === 'DELETE' && tokenId) {
      const id = Number(tokenId[1])
      if (!this.tokens.some((item) => item.id === id)) return reply.error(404, 'Not found')
      this.tokens = this.tokens.filter((item) => item.id !== id)
      return reply.empty()
    }

    if (method === 'GET' && path === '/api/ical-subscriptions') {
      return reply.json({ subscriptions: this.subscriptions })
    }
    if (method === 'POST' && path === '/api/ical-subscriptions') {
      const created = subscription(this.nextId++, {
        name: String(fields.name),
        url: String(fields.url),
        color: (fields.color as string | null) ?? null,
      })
      this.subscriptions = [...this.subscriptions, created]
      return reply.json(created, 201)
    }
    if (subscriptionId) {
      const id = Number(subscriptionId[1])
      const current = this.subscriptions.find((item) => item.id === id)
      if (!current) return reply.error(404, 'Not found')
      if (method === 'GET' && subscriptionId[2]) {
        const document = this.documents.get(id) ?? 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'
        return typeof document === 'string' ? { status: 200, text: document } : document
      }
      if (method === 'PUT') {
        if (current.shared) return reply.error(404, 'Not found')
        const saved = { ...current, ...(fields as Partial<Subscription>) }
        this.subscriptions = this.subscriptions.map((item) => (item.id === id ? saved : item))
        return reply.json(saved)
      }
      if (method === 'DELETE') {
        if (current.shared) return reply.error(404, 'Not found')
        this.subscriptions = this.subscriptions.filter((item) => item.id !== id)
        return reply.empty()
      }
    }
    return reply.error(404, 'Not found')
  }
}

/** `vi.mock` factory: the module `~/composables/useAuthFetch` on top of whatever `state.backend` is. */
export function authFetchModule(state: { backend: FakeBackend | null }) {
  return () => ({
    useAuthFetch: () =>
      createFetch({ fetch: (input, init) => state.backend!.fetch(input as string, init) }),
  })
}

// ---- DOM helpers ------------------------------------------------------------------------------

export const buttons = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLButtonElement>('button'),
]

/** A button by its accessible name (aria-label, else text). */
export function button(name: string | RegExp, root: ParentNode = document) {
  const match = (value: string) => (typeof name === 'string' ? value === name : name.test(value))
  return buttons(root).find((item) =>
    match(item.getAttribute('aria-label') ?? item.textContent?.trim() ?? ''),
  )
}

export function requireButton(name: string | RegExp, root: ParentNode = document) {
  const found = button(name, root)
  if (!found) throw new Error(`No button named ${String(name)}`)
  return found
}

/** The input a `<label>` points at, found by the start of the label text. */
export function field(label: string, root: ParentNode = document): HTMLInputElement {
  const element = [...root.querySelectorAll('label')].find((item) =>
    item.textContent?.trim().startsWith(label),
  )
  const input = element?.htmlFor ? document.getElementById(element.htmlFor) : null
  if (!(input instanceof HTMLInputElement)) throw new Error(`No input labelled ${label}`)
  return input
}

export function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export function keydown(target: Element | null, key: string) {
  target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** The alerts on the page; Nuxt UI's skeletons carry `role="alert"` too (hidden), so they are left out. */
export const alerts = () =>
  [...document.querySelectorAll('[role="alert"]')].filter(
    (item) => !item.classList.contains('animate-pulse'),
  )

export const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

/** The text of the live regions (`role="status"`), joined. */
export const statusText = () =>
  [...document.querySelectorAll('[role="status"]')]
    .map((item) => item.textContent?.trim())
    .filter(Boolean)
    .join(' | ')

export const errorTexts = () =>
  [...document.querySelectorAll('[id$="-error"]')].map((item) => item.textContent?.trim())

export const rows = (listName: string) => [
  ...document.querySelectorAll(`ul[aria-label="${listName}"] > li`),
]

/** Sets `navigator.clipboard` (absent in happy-dom); call the result to put things back. */
export function stubClipboard(writeText: (text: string) => Promise<void>): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return () => {
    if (had) Object.defineProperty(navigator, 'clipboard', had)
    else delete (navigator as { clipboard?: unknown }).clipboard
  }
}
