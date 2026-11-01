// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createConcurrencyLimiter,
  DEFAULT_GATEWAY_MAX_CONCURRENT_PER_USER,
  releaseWhenDone,
} from '../../server/utils/gateway/concurrency'

// Requests in flight per user (security review 2026-11-01, finding 9).

describe('createConcurrencyLimiter', () => {
  it('lets a key have `max` slots and refuses the next', () => {
    const limiter = createConcurrencyLimiter(2)
    const first = limiter.acquire('alice')
    const second = limiter.acquire('alice')
    expect(first).toBeTypeOf('function')
    expect(second).toBeTypeOf('function')
    expect(limiter.inFlight('alice')).toBe(2)
    expect(limiter.acquire('alice')).toBeNull()
    expect(limiter.inFlight('alice')).toBe(2)
  })

  it('gives a slot back, and only once however often release is called', () => {
    const limiter = createConcurrencyLimiter(1)
    const release = limiter.acquire('alice')!
    release()
    release()
    release()
    expect(limiter.inFlight('alice')).toBe(0)
    const again = limiter.acquire('alice')
    expect(again).not.toBeNull()
    // The extra releases of the first slot did not free this one.
    expect(limiter.acquire('alice')).toBeNull()
    again!()
  })

  it('counts every key on its own', () => {
    const limiter = createConcurrencyLimiter(1)
    expect(limiter.acquire('alice')).not.toBeNull()
    expect(limiter.acquire('alice')).toBeNull()
    expect(limiter.acquire('bob')).not.toBeNull()
  })

  it('reports a blocked key once per episode, not once per refused request', () => {
    const onBlocked = vi.fn()
    const limiter = createConcurrencyLimiter(1, onBlocked)
    const release = limiter.acquire('alice')!
    limiter.acquire('alice')
    limiter.acquire('alice')
    limiter.acquire('alice')
    expect(onBlocked).toHaveBeenCalledTimes(1)
    release()
    // A new episode after the key has been free again.
    const next = limiter.acquire('alice')!
    limiter.acquire('alice')
    expect(onBlocked).toHaveBeenCalledTimes(2)
    next()
  })

  it('forgets a key that has nothing in flight', () => {
    const limiter = createConcurrencyLimiter(3)
    const releases = [limiter.acquire('a')!, limiter.acquire('a')!]
    releases.forEach((release) => release())
    expect(limiter.inFlight('a')).toBe(0)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses a limit of %s', (max) => {
    expect(() => createConcurrencyLimiter(max)).toThrow(RangeError)
  })

  it('defaults to 8', () => {
    expect(DEFAULT_GATEWAY_MAX_CONCURRENT_PER_USER).toBe(8)
  })
})

describe('releaseWhenDone', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  function source(chunks: string[], fail = false): ReadableStream<Uint8Array> {
    let index = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(bytes(chunks[index++]!))
        else if (fail) controller.error(new Error('upstream broke'))
        else controller.close()
      },
    })
  }

  it('passes the data through and releases when the body has been read to its end', async () => {
    const release = vi.fn()
    const body = releaseWhenDone(source(['a', 'b', 'c']), release)
    const reader = body.getReader()
    const read: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read.push(new TextDecoder().decode(value))
      expect(release).not.toHaveBeenCalled()
    }
    expect(read.join('')).toBe('abc')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases when the body fails, and passes the error on', async () => {
    const release = vi.fn()
    const reader = releaseWhenDone(source(['a'], true), release).getReader()
    await reader.read()
    await expect(reader.read()).rejects.toThrow('upstream broke')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases when the reader walks away, and cancels the source', async () => {
    const release = vi.fn()
    const cancelled = vi.fn()
    const body = releaseWhenDone(
      new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(bytes('x')),
        cancel: (reason) => cancelled(reason),
      }),
      release,
    )
    const reader = body.getReader()
    await reader.read()
    expect(release).not.toHaveBeenCalled()
    await reader.cancel('client left')
    expect(release).toHaveBeenCalledTimes(1)
    expect(cancelled).toHaveBeenCalledWith('client left')
  })
})
