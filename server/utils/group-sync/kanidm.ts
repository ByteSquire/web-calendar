// Reads groups from Kanidm with the sync account's API token (GET /v1/group/<name>). The answer
// for a group the token may not read is `null` with HTTP 200, so `null` is a failure, never an
// empty group. The token goes into the Authorization header only; every message built here is
// scrubbed of it.
import { fail, type KanidmGroup, type Result } from './types'

export interface KanidmClientOptions {
  /** Origin of Kanidm: the origin of the OIDC issuer. */
  origin: string
  token: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}

export interface KanidmClient {
  readGroup(name: string): Promise<Result<KanidmGroup>>
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 1024 * 1024

export function kanidmOrigin(issuer: string): string | null {
  try {
    const url = new URL(issuer)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/** The text with every occurrence of the secret replaced. */
export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!response.body) {
    const text = await response.text()
    return text.length > maxBytes ? null : text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null
  return value
}

export function createKanidmClient(options: KanidmClientOptions): KanidmClient {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const clean = (text: string) => redact(text, options.token)

  return {
    async readGroup(name) {
      const label = `group "${name}"`
      let response: Response
      let text: string | null
      try {
        response = await doFetch(`${options.origin}/v1/group/${encodeURIComponent(name)}`, {
          headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => undefined)
          return fail(
            'unauthorized',
            `Kanidm refused the sync token for ${label} (HTTP ${response.status})`,
          )
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          return fail('http-error', `Kanidm answered HTTP ${response.status} for ${label}`)
        }
        text = await readCapped(response, maxBytes)
      } catch (error) {
        const errorName = error instanceof Error ? error.name : ''
        if (errorName === 'TimeoutError' || errorName === 'AbortError') {
          return fail('timeout', `Kanidm did not answer for ${label} within ${timeoutMs} ms`)
        }
        const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code
        return fail(
          'network',
          clean(`cannot reach Kanidm for ${label}${typeof code === 'string' ? ` (${code})` : ''}`),
        )
      }
      if (text === null)
        return fail('too-large', `the answer for ${label} is over ${maxBytes} bytes`)

      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return fail('malformed', `the answer for ${label} is not JSON`)
      }
      if (body === null) {
        return fail(
          'null-answer',
          `Kanidm answered null for ${label} (not readable, or it does not exist)`,
        )
      }
      const attrs = (body as { attrs?: unknown } | undefined)?.attrs
      if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) {
        return fail('malformed', `the answer for ${label} has no attrs object`)
      }
      const record = attrs as Record<string, unknown>
      const names = stringList(record.name)
      if (!names || names[0]?.toLowerCase() !== name.toLowerCase()) {
        return fail('malformed', `the answer for ${label} names another group`)
      }
      // A group without members has no `member` attribute.
      const members = stringList(record.member)
      if (!members || members.some((member) => member.trim() === '' || /\s/.test(member))) {
        return fail('malformed', `the member list of ${label} is malformed`)
      }
      return { ok: true, value: { name, members } }
    },
  }
}
