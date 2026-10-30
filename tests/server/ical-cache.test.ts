// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createIcalProxy,
  MAX_FETCHES_PER_USER,
  type IcalProxyDeps,
} from '../../server/utils/ical-proxy/cache'
import { IcalFetchError } from '../../server/utils/ical-proxy/errors'
import type { FetchOptions, FetchResult } from '../../server/utils/ical-proxy/fetcher'
import { createAddressPolicy } from '../../server/utils/ical-proxy/ssrf'

// The cache, the shared fetches and the per-user limit with a scripted fetcher and a clock the
// test moves by hand. The real fetcher through the cache is in ical-fetcher.test.ts.

const policy = createAddressPolicy({ allowPrivate: false })
const config = { cacheTtlSec: 300, maxBytes: 5_000_000, timeoutMs: 10_000, allowPrivate: false }
const alice = { userId: 1, subscriptionId: 1 }
const bob = { userId: 2, subscriptionId: 2 }

let clock: number
let logs: string[]

beforeEach(() => {
  clock = 1_000_000
  logs = []
})

function ok(body: string, extra: Partial<Extract<FetchResult, { kind: 'ok' }>> = {}): FetchResult {
  return {
    kind: 'ok',
    body,
    bytes: body.length,
    etag: null,
    lastModified: null,
    ...extra,
  }
}

type FetchFn = (url: string, options: FetchOptions) => Promise<FetchResult>

function makeProxy(fetch: FetchFn, overrides: Partial<IcalProxyDeps> = {}) {
  const spy = vi.fn(fetch)
  return {
    fetch: spy,
    proxy: createIcalProxy({
      config,
      policy,
      now: () => clock,
      log: (message) => logs.push(message),
      fetch: spy,
      ...overrides,
    }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const advance = (seconds: number) => {
  clock += seconds * 1000
}

describe('the cache', () => {
  it('passes the policy and limits to the fetcher', async () => {
    const { proxy, fetch } = makeProxy(async () => ok('A'))
    await proxy.get('https://a.example/x.ics', alice)
    expect(fetch).toHaveBeenCalledWith('https://a.example/x.ics', {
      policy,
      maxBytes: 5_000_000,
      timeoutMs: 10_000,
      validators: undefined,
    })
  })

  it('serves from memory within the TTL, to every user', async () => {
    const { proxy, fetch } = makeProxy(async () => ok('A', { etag: '"1"' }))
    const url = 'https://a.example/x.ics'
    expect(await proxy.get(url, alice)).toEqual({ body: 'A', etag: '"1"' })
    advance(299)
    expect(await proxy.get(url, bob)).toEqual({ body: 'A', etag: '"1"' })
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(1)
    await proxy.get(url, alice)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps one entry per address', async () => {
    const { proxy, fetch } = makeProxy(async (url) => ok(url))
    expect((await proxy.get('https://a.example/1.ics', alice)).body).toBe('https://a.example/1.ics')
    expect((await proxy.get('https://a.example/2.ics', alice)).body).toBe('https://a.example/2.ics')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('asks the source every time with a TTL of 0', async () => {
    const { proxy, fetch } = makeProxy(async () => ok('A'), {
      config: { ...config, cacheTtlSec: 0 },
    })
    await proxy.get('https://a.example/x.ics', alice)
    await proxy.get('https://a.example/x.ics', alice)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('revalidates with the stored validators and keeps the body on not-modified', async () => {
    const answers: FetchResult[] = [
      ok('A', { etag: '"1"', lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' }),
      { kind: 'not-modified', etag: null, lastModified: null },
    ]
    const { proxy, fetch } = makeProxy(async () => answers.shift()!)
    const url = 'https://a.example/x.ics'
    await proxy.get(url, alice)
    advance(301)
    expect(await proxy.get(url, alice)).toEqual({ body: 'A', etag: '"1"' })
    expect(fetch.mock.calls[1]![1].validators).toEqual({
      etag: '"1"',
      lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT',
    })
    // A 304 starts a new TTL.
    advance(299)
    await proxy.get(url, alice)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('takes over a validator that the 304 brings', async () => {
    const answers: FetchResult[] = [
      ok('A', { etag: '"1"' }),
      { kind: 'not-modified', etag: '"1b"', lastModified: null },
      { kind: 'not-modified', etag: null, lastModified: null },
    ]
    const { proxy, fetch } = makeProxy(async () => answers.shift()!)
    await proxy.get('https://a.example/x.ics', alice)
    advance(301)
    await proxy.get('https://a.example/x.ics', alice)
    advance(301)
    expect(await proxy.get('https://a.example/x.ics', alice)).toEqual({ body: 'A', etag: '"1b"' })
    expect(fetch.mock.calls[2]![1].validators?.etag).toBe('"1b"')
  })

  it('fetches unconditionally when the source gave no validator', async () => {
    const { proxy, fetch } = makeProxy(async () => ok('A'))
    await proxy.get('https://a.example/x.ics', alice)
    advance(301)
    await proxy.get('https://a.example/x.ics', alice)
    expect(fetch.mock.calls[1]![1].validators).toBeUndefined()
  })

  it('replaces the body when the source sends a new one', async () => {
    const answers = [ok('A', { etag: '"1"' }), ok('B', { etag: '"2"' })]
    const { proxy } = makeProxy(async () => answers.shift()!)
    await proxy.get('https://a.example/x.ics', alice)
    advance(301)
    expect(await proxy.get('https://a.example/x.ics', alice)).toEqual({ body: 'B', etag: '"2"' })
  })
})

describe('failures', () => {
  it('never serves the stale copy: an error drops the entry and is reported', async () => {
    const answers: (FetchResult | IcalFetchError)[] = [
      ok('A', { etag: '"1"' }),
      new IcalFetchError('http-503'),
      new IcalFetchError('http-503'),
      ok('B'),
    ]
    const { proxy, fetch } = makeProxy(async () => {
      const next = answers.shift()!
      if (next instanceof IcalFetchError) throw next
      return next
    })
    const url = 'https://a.example/x.ics'
    await proxy.get(url, alice)

    advance(301)
    await expect(proxy.get(url, alice)).rejects.toMatchObject({ reason: 'http-503' })
    expect(proxy.stats()).toEqual({ entries: 0, bytes: 0, inFlight: 0 })

    // Right after the failure and later still: an error again, not the old calendar.
    await expect(proxy.get(url, alice)).rejects.toMatchObject({ reason: 'http-503' })
    // The dropped entry also means the retry is unconditional.
    expect(fetch.mock.calls[2]![1].validators).toBeUndefined()

    expect((await proxy.get(url, alice)).body).toBe('B')
  })

  it.each(['blocked', 'unreachable', 'timeout', 'too-large', 'not-ical', 'http-404'] as const)(
    'passes the reason %s on',
    async (reason) => {
      const { proxy } = makeProxy(async () => {
        throw new IcalFetchError(reason)
      })
      await expect(proxy.get('https://a.example/x.ics', alice)).rejects.toMatchObject({ reason })
    },
  )

  it('reports a failure that is not ours as unreachable', async () => {
    const { proxy } = makeProxy(async () => {
      throw new TypeError('something broke')
    })
    const error = await proxy.get('https://a.example/x.ics', alice).catch((caught) => caught)
    expect(error).toBeInstanceOf(IcalFetchError)
    expect(error.reason).toBe('unreachable')
  })

  it('does not cache a failure', async () => {
    let fail = true
    const { proxy, fetch } = makeProxy(async () => {
      if (fail) throw new IcalFetchError('timeout')
      return ok('A')
    })
    await expect(proxy.get('https://a.example/x.ics', alice)).rejects.toMatchObject({
      reason: 'timeout',
    })
    fail = false
    expect((await proxy.get('https://a.example/x.ics', alice)).body).toBe('A')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('logs the reason, the subscription and the host, never the path or query', async () => {
    const { proxy } = makeProxy(async () => {
      throw new IcalFetchError('http-403', 'forbidden')
    })
    await proxy
      .get('https://calendar.example:8443/private/secret-token/basic.ics?key=SECRET', {
        userId: 1,
        subscriptionId: 42,
      })
      .catch(() => undefined)
    expect(logs).toEqual(['[ical-proxy] sub 42 host=calendar.example:8443: http-403 (forbidden)'])
  })
})

describe('shared fetches', () => {
  it('lets concurrent requests for one address share one upstream fetch', async () => {
    const gate = deferred<FetchResult>()
    const { proxy, fetch } = makeProxy(() => gate.promise)
    const url = 'https://a.example/x.ics'
    const requests = [
      proxy.get(url, alice),
      proxy.get(url, alice),
      proxy.get(url, bob),
      proxy.get(url, bob),
    ]
    await tick()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(proxy.stats().inFlight).toBe(1)
    gate.resolve(ok('A'))
    expect((await Promise.all(requests)).map((result) => result.body)).toEqual(['A', 'A', 'A', 'A'])
    expect(proxy.stats().inFlight).toBe(0)
  })

  it('shares a failure with everyone who waited, then tries again', async () => {
    const gate = deferred<FetchResult>()
    const answers = [() => gate.promise, async () => ok('A')]
    const { proxy, fetch } = makeProxy(() => answers.shift()!())
    const url = 'https://a.example/x.ics'
    const requests = [proxy.get(url, alice), proxy.get(url, bob)]
    await tick()
    gate.reject(new IcalFetchError('timeout'))
    const settled = await Promise.allSettled(requests)
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(proxy.stats().inFlight).toBe(0)
    expect((await proxy.get(url, alice)).body).toBe('A')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not let a joiner take a slot of its own', async () => {
    const gate = deferred<FetchResult>()
    const { proxy, fetch } = makeProxy(() => gate.promise, { maxFetchesPerUser: 1 })
    const first = proxy.get('https://a.example/x.ics', alice)
    // Same address, same user, one slot: joining must not wait for a second slot.
    const joiner = proxy.get('https://a.example/x.ics', alice)
    await tick()
    gate.resolve(ok('A'))
    expect((await Promise.all([first, joiner])).map((result) => result.body)).toEqual(['A', 'A'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('the limit per user', () => {
  function gated() {
    const gates = new Map<string, ReturnType<typeof deferred<FetchResult>>>()
    const started: string[] = []
    const fetch: FetchFn = (url) => {
      started.push(url)
      const gate = deferred<FetchResult>()
      gates.set(url, gate)
      return gate.promise
    }
    return { fetch, gates, started }
  }

  const urls = Array.from({ length: 7 }, (_, n) => `https://a.example/${n}.ics`)

  it('runs at most four fetches of one user at a time and starts the rest as slots free up', async () => {
    expect(MAX_FETCHES_PER_USER).toBe(4)
    const { fetch, gates, started } = gated()
    const { proxy } = makeProxy(fetch)
    const requests = urls.map((url) => proxy.get(url, alice))
    await tick()
    expect(started).toEqual(urls.slice(0, 4))

    gates.get(urls[1]!)!.resolve(ok('1'))
    await tick()
    expect(started).toEqual(urls.slice(0, 5))

    gates.get(urls[0]!)!.resolve(ok('0'))
    gates.get(urls[2]!)!.resolve(ok('2'))
    await tick()
    expect(started).toEqual(urls.slice(0, 7))

    for (const url of urls) gates.get(url)?.resolve(ok(url))
    const results = await Promise.all(requests)
    expect(results).toHaveLength(7)
  })

  it('frees the slot of a failed fetch', async () => {
    const { fetch, gates, started } = gated()
    const { proxy } = makeProxy(fetch, { maxFetchesPerUser: 1 })
    const first = proxy.get(urls[0]!, alice)
    const second = proxy.get(urls[1]!, alice)
    await tick()
    expect(started).toEqual([urls[0]])
    gates.get(urls[0]!)!.reject(new IcalFetchError('timeout'))
    await expect(first).rejects.toMatchObject({ reason: 'timeout' })
    await tick()
    expect(started).toEqual([urls[0], urls[1]])
    gates.get(urls[1]!)!.resolve(ok('B'))
    expect((await second).body).toBe('B')
  })

  it('does not hold back another user', async () => {
    const { fetch, started } = gated()
    const { proxy } = makeProxy(fetch, { maxFetchesPerUser: 2 })
    for (const url of urls.slice(0, 4)) void proxy.get(url, alice).catch(() => undefined)
    void proxy.get('https://b.example/x.ics', bob).catch(() => undefined)
    await tick()
    expect(started).toEqual([urls[0], urls[1], 'https://b.example/x.ics'])
  })
})

describe('the bounds of the cache', () => {
  it('evicts the least recently used entry beyond the entry limit', async () => {
    const { proxy, fetch } = makeProxy(async (url) => ok(url), { maxEntries: 3 })
    const url = (n: number) => `https://a.example/${n}.ics`
    for (const n of [1, 2, 3]) await proxy.get(url(n), alice)
    await proxy.get(url(1), alice) // 1 is now the most recently used, 2 the least
    await proxy.get(url(4), alice) // evicts 2
    expect(proxy.stats().entries).toBe(3)

    fetch.mockClear()
    await proxy.get(url(1), alice)
    await proxy.get(url(3), alice)
    await proxy.get(url(4), alice)
    expect(fetch).not.toHaveBeenCalled()
    await proxy.get(url(2), alice)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('evicts by total size', async () => {
    const { proxy } = makeProxy(async () => ok('x'.repeat(40), { bytes: 40 }), { maxBytes: 100 })
    for (const n of [1, 2, 3]) await proxy.get(`https://a.example/${n}.ics`, alice)
    expect(proxy.stats()).toEqual({ entries: 2, bytes: 80, inFlight: 0 })
  })

  it('returns a file that is larger than the whole budget without keeping it', async () => {
    const { proxy, fetch } = makeProxy(async () => ok('x'.repeat(200), { bytes: 200 }), {
      maxBytes: 100,
    })
    await proxy.get('https://a.example/small.ics', alice)
    const big = 'https://a.example/big.ics'
    expect((await proxy.get(big, alice)).body).toHaveLength(200)
    expect(proxy.stats().entries).toBe(0)
    await proxy.get(big, alice)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('counts a replaced entry once', async () => {
    const sizes = [40, 70]
    const { proxy } = makeProxy(async () => ok('x', { bytes: sizes.shift()! }))
    await proxy.get('https://a.example/x.ics', alice)
    advance(301)
    await proxy.get('https://a.example/x.ics', alice)
    expect(proxy.stats()).toEqual({ entries: 1, bytes: 70, inFlight: 0 })
  })

  it('forgets everything on clear', async () => {
    const { proxy, fetch } = makeProxy(async () => ok('A'))
    await proxy.get('https://a.example/x.ics', alice)
    proxy.clear()
    expect(proxy.stats().entries).toBe(0)
    await proxy.get('https://a.example/x.ics', alice)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
