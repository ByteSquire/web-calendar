// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createUserLimiter, type Admission } from '../../server/utils/external/limits'

// The per-user limits of the proxy: a token bucket (burst 60, 20 per second by default) and a cap
// on requests in flight, per user and in total, with tables that cannot grow without bound.

function clock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function admitted(admission: Admission) {
  if (!admission.ok) throw new Error(`refused for ${admission.retryAfterSec} s`)
  return admission
}

describe('the request rate', () => {
  it('allows the burst of 60, then refuses with the seconds to wait', () => {
    const time = clock()
    const limiter = createUserLimiter({
      now: time.now,
      maxConcurrentPerUser: 1000,
      maxConcurrentTotal: 1000,
    })
    for (let i = 0; i < 60; i++) admitted(limiter.admit(1)).release()
    const refused = limiter.admit(1)
    expect(refused).toEqual({ ok: false, retryAfterSec: 1 })
  })

  it('refills 20 tokens per second, up to the burst', () => {
    const time = clock()
    const limiter = createUserLimiter({
      now: time.now,
      maxConcurrentPerUser: 1000,
      maxConcurrentTotal: 1000,
    })
    for (let i = 0; i < 60; i++) admitted(limiter.admit(1)).release()
    expect(limiter.admit(1).ok).toBe(false)
    time.advance(50) // one token
    admitted(limiter.admit(1)).release()
    expect(limiter.admit(1).ok).toBe(false)
    time.advance(1000) // 20 tokens
    for (let i = 0; i < 20; i++) admitted(limiter.admit(1)).release()
    expect(limiter.admit(1).ok).toBe(false)
    time.advance(60_000) // far more than the burst
    for (let i = 0; i < 60; i++) admitted(limiter.admit(1)).release()
    expect(limiter.admit(1).ok).toBe(false)
  })

  it('tells how long to wait when the bucket is empty', () => {
    const time = clock()
    const limiter = createUserLimiter({
      burst: 2,
      refillPerSec: 0.5,
      now: time.now,
      maxConcurrentPerUser: 1000,
      maxConcurrentTotal: 1000,
    })
    admitted(limiter.admit(1)).release()
    admitted(limiter.admit(1)).release()
    expect(limiter.admit(1)).toEqual({ ok: false, retryAfterSec: 2 })
    time.advance(1000)
    expect(limiter.admit(1)).toEqual({ ok: false, retryAfterSec: 1 })
  })

  it('counts each user on their own', () => {
    const time = clock()
    const limiter = createUserLimiter({
      burst: 3,
      now: time.now,
      maxConcurrentPerUser: 1000,
      maxConcurrentTotal: 1000,
    })
    for (let i = 0; i < 3; i++) admitted(limiter.admit(1)).release()
    expect(limiter.admit(1).ok).toBe(false)
    for (let i = 0; i < 3; i++) admitted(limiter.admit(2)).release()
    expect(limiter.admit(2).ok).toBe(false)
  })

  it('does not take a token for a request refused because of concurrency', () => {
    const time = clock()
    const limiter = createUserLimiter({ burst: 3, maxConcurrentPerUser: 1, now: time.now })
    const first = admitted(limiter.admit(1))
    for (let i = 0; i < 10; i++) expect(limiter.admit(1).ok).toBe(false)
    first.release()
    admitted(limiter.admit(1)).release()
    admitted(limiter.admit(1)).release()
    expect(limiter.admit(1).ok).toBe(false) // the third token of three went to the first request
  })

  it('survives a clock that jumps back', () => {
    const time = clock()
    const limiter = createUserLimiter({ burst: 2, now: time.now })
    admitted(limiter.admit(1)).release()
    time.advance(-60_000)
    admitted(limiter.admit(1)).release()
    expect(limiter.admit(1).ok).toBe(false)
  })
})

describe('requests in flight', () => {
  it('allows 8 per user at once and refuses the ninth with Retry-After, without queueing', () => {
    const limiter = createUserLimiter({ maxConcurrentTotal: 100 })
    const held = Array.from({ length: 8 }, () => admitted(limiter.admit(1)))
    expect(limiter.admit(1)).toEqual({ ok: false, retryAfterSec: 1 })
    // Another user is not affected.
    admitted(limiter.admit(2)).release()
    held[0]!.release()
    admitted(limiter.admit(1)).release()
  })

  it('a slot is given back once, however often release is called', () => {
    const limiter = createUserLimiter({ maxConcurrentPerUser: 2, maxConcurrentTotal: 100 })
    const a = admitted(limiter.admit(1))
    admitted(limiter.admit(1))
    a.release()
    a.release()
    a.release()
    expect(limiter.size().running).toBe(1)
    admitted(limiter.admit(1))
    expect(limiter.admit(1).ok).toBe(false)
  })

  it('caps all users together', () => {
    const limiter = createUserLimiter({ maxConcurrentTotal: 3, maxConcurrentPerUser: 8 })
    const held = [1, 2, 3].map((user) => admitted(limiter.admit(user)))
    expect(limiter.admit(4).ok).toBe(false)
    held[1]!.release()
    admitted(limiter.admit(4)).release()
  })

  it('forgets a user whose requests have all ended', () => {
    const limiter = createUserLimiter({})
    const a = admitted(limiter.admit(1))
    const b = admitted(limiter.admit(2))
    expect(limiter.size().running).toBe(2)
    a.release()
    b.release()
    expect(limiter.size().running).toBe(0)
  })
})

describe('the table', () => {
  it('stays within its bound, dropping the least recently used users', () => {
    const time = clock()
    const limiter = createUserLimiter({ maxTrackedUsers: 100, now: time.now })
    for (let user = 1; user <= 5000; user++) {
      admitted(limiter.admit(user)).release()
      time.advance(1)
    }
    expect(limiter.size().buckets).toBeLessThanOrEqual(100)
  })

  it('drops buckets that have refilled before those that have not', () => {
    const time = clock()
    const limiter = createUserLimiter({ burst: 2, maxTrackedUsers: 2, now: time.now })
    admitted(limiter.admit(1)).release()
    admitted(limiter.admit(1)).release() // user 1 is empty
    time.advance(1)
    admitted(limiter.admit(2)).release()
    time.advance(60_000) // user 2 is full again, user 1 too: both can go
    admitted(limiter.admit(3)).release()
    expect(limiter.size().buckets).toBeLessThanOrEqual(2)
  })

  it('a user that is over the limit stays tracked, so evicting others cannot reset them', () => {
    const time = clock()
    const limiter = createUserLimiter({ burst: 1, maxTrackedUsers: 3, now: time.now })
    admitted(limiter.admit(1)).release()
    for (let user = 10; user < 20; user++) {
      expect(limiter.admit(1).ok).toBe(false)
      admitted(limiter.admit(user)).release()
      time.advance(1)
    }
    expect(limiter.admit(1).ok).toBe(false)
  })
})

describe('options', () => {
  it.each([
    { burst: 0 },
    { burst: 1.5 },
    { refillPerSec: 0 },
    { refillPerSec: -1 },
    { maxConcurrentPerUser: 0 },
    { maxConcurrentTotal: 0 },
    { maxTrackedUsers: 0 },
    { burst: Number.NaN },
  ])('refuses %j', (options) => {
    expect(() => createUserLimiter(options)).toThrow(TypeError)
  })
})
