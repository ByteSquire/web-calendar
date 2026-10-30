import type { IncomingMessage } from 'node:http'
import { IcalFetchError } from './errors'
import { openGuardedRequest } from './guarded-request'
import { hostnameOf, hostRefusal, type AddressPolicy } from './ssrf'
import { sourceUrlProblem } from './source-url'

// One guarded GET of an .ics file (FR-7), opened by guarded-request.ts. Everything is bounded: one
// deadline for all hops, a size cap while streaming, at most 3 redirects, each hop checked anew.

export const MAX_REDIRECTS = 3
const USER_AGENT = 'web-calendar-ical-proxy'

export interface FetchOptions {
  policy: AddressPolicy
  maxBytes: number
  /** One deadline for all hops and the body. */
  timeoutMs: number
  /** Validators of a cached copy; a matching source answers 304. */
  validators?: { etag: string | null; lastModified: string | null }
  maxRedirects?: number
}

export type FetchResult =
  | {
      kind: 'ok'
      body: string
      /** Size on the wire, for the cache budget. */
      bytes: number
      etag: string | null
      lastModified: string | null
    }
  | { kind: 'not-modified'; etag: string | null; lastModified: string | null }

type Hop = FetchResult | { kind: 'redirect'; location: string }

function headerValue(response: IncomingMessage, name: string): string | null {
  const value = response.headers[name]
  return typeof value === 'string' && value !== '' ? value : null
}

function requestOnce(url: URL, options: FetchOptions, signal: AbortSignal): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false
    let rejectedByGuard: IcalFetchError | undefined
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/calendar, text/plain;q=0.5',
      // Identity only: a compressed body would have to be size-capped after decompression too.
      'Accept-Encoding': 'identity',
      Connection: 'close',
    }
    // The same validators go to every hop; they say nothing the source did not say itself.
    if (options.validators?.etag) headers['If-None-Match'] = options.validators.etag
    if (options.validators?.lastModified) {
      headers['If-Modified-Since'] = options.validators.lastModified
    }

    const request = openGuardedRequest(url, {
      method: 'GET',
      headers,
      policy: options.policy,
      onReject: (error) => {
        rejectedByGuard = error
      },
    })

    function finish(outcome: Hop | IcalFetchError): void {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (outcome instanceof IcalFetchError) {
        request.destroy()
        reject(outcome)
      } else {
        resolve(outcome)
      }
    }
    function onAbort(): void {
      finish(new IcalFetchError('timeout'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    request.on('error', (error: NodeJS.ErrnoException) => {
      if (rejectedByGuard) return finish(rejectedByGuard)
      if (error instanceof IcalFetchError) return finish(error)
      finish(new IcalFetchError('unreachable', error.code ?? error.message, { cause: error }))
    })

    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      const etag = headerValue(response, 'etag')
      const lastModified = headerValue(response, 'last-modified')
      const stop = (error: IcalFetchError): void => {
        response.destroy()
        finish(error)
      }

      if (status === 304) {
        response.destroy()
        return finish({ kind: 'not-modified', etag, lastModified })
      }
      if (status >= 300 && status < 400) {
        const location = headerValue(response, 'location')
        response.destroy()
        return finish(
          location
            ? { kind: 'redirect', location }
            : new IcalFetchError(`http-${status}`, 'redirect without Location'),
        )
      }
      if (status !== 200) return stop(new IcalFetchError(`http-${status}`))

      const encoding = headerValue(response, 'content-encoding')
      if (encoding && encoding.toLowerCase() !== 'identity') {
        return stop(new IcalFetchError('not-ical', `unexpected Content-Encoding ${encoding}`))
      }
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        return stop(new IcalFetchError('too-large', 'Content-Length over the limit'))
      }

      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        received += chunk.length
        if (received > options.maxBytes) {
          return stop(new IcalFetchError('too-large', 'body over the limit'))
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        const body = new TextDecoder('utf-8').decode(Buffer.concat(chunks))
        if (!/^BEGIN:VCALENDAR/i.test(body.trimStart())) {
          return finish(new IcalFetchError('not-ical'))
        }
        finish({ kind: 'ok', body, bytes: received, etag, lastModified })
      })
      // A connection that drops mid-body ends with 'error' or only 'close', never 'end'.
      response.on('error', (error: NodeJS.ErrnoException) => {
        finish(new IcalFetchError('unreachable', error.code ?? error.message, { cause: error }))
      })
      response.on('close', () => {
        finish(new IcalFetchError('unreachable', 'connection closed early'))
      })
    })

    request.end()
  })
}

/**
 * Fetches `rawUrl` (already normalised by `parseSourceUrl`). Throws `IcalFetchError`. Returns
 * `not-modified` only when `options.validators` were sent and the source answered 304.
 */
export async function fetchIcal(rawUrl: string, options: FetchOptions): Promise<FetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const hasValidators = Boolean(options.validators?.etag || options.validators?.lastModified)
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs)

  try {
    let current: URL
    try {
      current = new URL(rawUrl)
    } catch (cause) {
      throw new IcalFetchError('unreachable', 'the stored address is not a valid URL', { cause })
    }

    for (let redirects = 0; ; redirects++) {
      if (deadline.signal.aborted) throw new IcalFetchError('timeout')
      // Every hop, the first included: scheme, credentials, then the host list, IP literals and
      // `localhost`. Names are checked again when the connection looks them up.
      const problem = sourceUrlProblem(current)
      if (problem) throw new IcalFetchError('blocked', problem)
      const refusal = hostRefusal(hostnameOf(current), options.policy)
      if (refusal) throw refusal

      const hop = await requestOnce(current, options, deadline.signal)
      if (hop.kind === 'ok') return hop
      if (hop.kind === 'not-modified') {
        // Nothing was asked conditionally, so a 304 is the source misbehaving.
        if (!hasValidators) throw new IcalFetchError('http-304', 'unexpected 304')
        return hop
      }

      if (redirects >= maxRedirects) {
        throw new IcalFetchError('unreachable', `more than ${maxRedirects} redirects`)
      }
      try {
        // Relative Locations resolve against the hop that sent them; the fragment is never sent.
        current = new URL(hop.location, current)
      } catch (cause) {
        throw new IcalFetchError('unreachable', 'invalid redirect Location', { cause })
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
