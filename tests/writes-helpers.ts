// A fake CalDAV collection and the injected services of the write orchestration, for the tests of
// app/utils/writes. The fake follows the conditional-write rules of the real client: `create` fails
// with `exists`, a wrong `etag` with `conflict`, a missing resource with `not-found` on reads.
import { DavError, type DavErrorKind } from '../app/utils/caldav/errors'
import type { DavObject } from '../app/utils/caldav/types'
import type { WriteDeps } from '../app/utils/writes/types'

export const NOW = new Date('2026-10-30T12:00:00Z')
export const CALENDAR = '/caldav/alice/work/'

export interface Call {
  method: 'GET' | 'PUT' | 'DELETE'
  url: string
  etag?: string
  create?: boolean
  data?: string
}

interface Failure {
  method: Call['method']
  kind: DavErrorKind
  /** Calls of the method that pass first. */
  after: number
}

export class FakeCalendarServer {
  readonly resources = new Map<string, { data: string; etag: string }>()
  readonly calls: Call[] = []
  private counter = 0
  private failures: Failure[] = []

  /** Put a resource there without a call being recorded; returns its ETag. */
  seed(url: string, data: string): string {
    const etag = this.nextEtag()
    this.resources.set(url, { data, etag })
    return etag
  }

  /** Someone else saved the resource meanwhile: a new ETag (and new text if given). */
  touch(url: string, data?: string): string {
    const current = this.resources.get(url)
    if (!current) throw new Error(`no resource at ${url}`)
    const etag = this.nextEtag()
    this.resources.set(url, { data: data ?? current.data, etag })
    return etag
  }

  /** The next call of `method` (after `after` others) fails with a `DavError` of `kind`. */
  failNext(method: Call['method'], kind: DavErrorKind, after = 0): void {
    this.failures.push({ method, kind, after })
  }

  etagOf(url: string): string | undefined {
    return this.resources.get(url)?.etag
  }

  dataOf(url: string): string {
    const resource = this.resources.get(url)
    if (!resource) throw new Error(`no resource at ${url}`)
    return resource.data
  }

  callsOf(method: Call['method']): Call[] {
    return this.calls.filter((call) => call.method === method)
  }

  private nextEtag(): string {
    this.counter += 1
    return `"etag-${this.counter}"`
  }

  private maybeFail(method: Call['method']): void {
    const failure = this.failures.find((item) => item.method === method)
    if (!failure) return
    if (failure.after > 0) {
      failure.after -= 1
      return
    }
    this.failures = this.failures.filter((item) => item !== failure)
    throw new DavError(failure.kind, `${method} failed (fake)`)
  }

  readonly client: WriteDeps['client'] = {
    getObject: async (url): Promise<DavObject> => {
      this.calls.push({ method: 'GET', url })
      this.maybeFail('GET')
      const resource = this.resources.get(url)
      if (!resource) throw new DavError('not-found', 'GET failed with HTTP 404', { status: 404 })
      return { url, etag: resource.etag, data: resource.data }
    },
    putObject: async (args) => {
      this.calls.push({
        method: 'PUT',
        url: args.url,
        data: args.data,
        ...(args.etag === undefined ? {} : { etag: args.etag }),
        ...(args.create ? { create: true } : {}),
      })
      this.maybeFail('PUT')
      const current = this.resources.get(args.url)
      if (args.create && current) throw new DavError('exists', 'PUT: exists', { status: 412 })
      if (args.etag !== undefined && current?.etag !== args.etag) {
        throw new DavError('conflict', 'PUT: precondition failed', { status: 412 })
      }
      const etag = this.nextEtag()
      this.resources.set(args.url, { data: args.data, etag })
      return { url: args.url, etag }
    },
    deleteObject: async (url, etag) => {
      this.calls.push({ method: 'DELETE', url, ...(etag === undefined ? {} : { etag }) })
      this.maybeFail('DELETE')
      const current = this.resources.get(url)
      if (!current) throw new DavError('not-found', 'DELETE failed with HTTP 404', { status: 404 })
      if (etag !== undefined && current.etag !== etag) {
        throw new DavError('conflict', 'DELETE: precondition failed', { status: 412 })
      }
      this.resources.delete(url)
    },
  }
}

export interface Env {
  deps: WriteDeps
  /** Calendars whose reader cache was dropped, in order. */
  invalidated: string[]
  /** How many times the loader was asked to reload. */
  refreshes: () => number
}

export function makeEnv(
  server: FakeCalendarServer,
  options: { refresh?: () => Promise<void>; displayTimeZone?: string; orgTimeZone?: string } = {},
): Env {
  const invalidated: string[] = []
  let refreshes = 0
  const deps: WriteDeps = {
    client: server.client,
    reader: { invalidate: (calendarUrl) => invalidated.push(calendarUrl) },
    refresh:
      options.refresh ??
      (async () => {
        refreshes += 1
      }),
    zones: () => ({
      displayTimeZone: options.displayTimeZone ?? 'Europe/Berlin',
      orgTimeZone: options.orgTimeZone ?? 'Europe/Berlin',
    }),
    now: () => NOW,
  }
  return { deps, invalidated, refreshes: () => refreshes }
}
