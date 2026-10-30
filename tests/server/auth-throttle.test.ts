// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createBasicThrottle,
  describeBlock,
  type BasicThrottleOptions,
  type ThrottleBlock,
} from '../../server/utils/auth/throttle'

const START = 1_800_000_000_000
const ADDRESS = '203.0.113.9'

function setup(options: BasicThrottleOptions = {}) {
  const clock = { ms: START }
  const blocks: ThrottleBlock[] = []
  const throttle = createBasicThrottle({
    now: () => clock.ms,
    onBlock: (block) => blocks.push(block),
    ...options,
  })
  const advance = (seconds: number) => {
    clock.ms += seconds * 1000
  }
  /** The answers to `times` failed logins in a row: null (a 401) or the Retry-After of a 429. */
  const fail = (address: string | null | undefined, username: string, times = 1) => {
    const answers: (number | null)[] = []
    for (let i = 0; i < times; i++) answers.push(throttle.recordFailure(address, username))
    return answers
  }
  /** The answer to the last of `times` failed logins. */
  const failLast = (address: string | null | undefined, username: string, times = 1) =>
    fail(address, username, times).at(-1)
  /** Failed logins of `times` different user names, which no per-user counter ever reaches. */
  let names = 0
  const spray = (address: string | null | undefined, times = 1) =>
    Array.from({ length: times }, () => throttle.recordFailure(address, `sprayed-${names++}`))
  return { throttle, clock, blocks, advance, fail, failLast, spray }
}

describe('createBasicThrottle: failures per user name and address', () => {
  it('answers 401 for the first four failures and a wait from the fifth, the one that reaches the limit', () => {
    const { fail } = setup()
    expect(fail(ADDRESS, 'alice', 7)).toEqual([null, null, null, null, 600, 600, 600])
  })

  it.each([
    [1, null],
    [4, null],
    [5, 600],
    [6, 600],
  ])('after %i failures the answer is %s', (failures, expected) => {
    const { failLast } = setup()
    expect(failLast(ADDRESS, 'alice', failures)).toBe(expected)
  })

  it('counts the combination only: other users and other addresses start from zero', () => {
    const { fail } = setup()
    fail(ADDRESS, 'alice', 5)
    // A stranger guessing for alice from elsewhere is counted on its own.
    expect(fail('198.51.100.7', 'alice', 4)).toEqual([null, null, null, null])
    expect(fail(ADDRESS, 'bob', 4)).toEqual([null, null, null, null])
  })

  it('treats user names case-insensitively', () => {
    const { fail, throttle } = setup()
    fail(ADDRESS, 'Alice', 2)
    fail(ADDRESS, 'ALICE', 2)
    expect(fail(ADDRESS, 'aLiCe')).toEqual([600])
    expect(throttle.size().users).toBe(1)
  })

  it('keeps user names that differ in more than case apart', () => {
    const { fail } = setup()
    fail(ADDRESS, 'alice', 5)
    expect(fail(ADDRESS, 'alice ')).toEqual([null])
    expect(fail(ADDRESS, 'alice2')).toEqual([null])
  })

  it('honours another limit', () => {
    const { fail } = setup({ maxUserFailures: 2 })
    expect(fail(ADDRESS, 'alice', 3)).toEqual([null, 600, 600])
  })
})

describe('createBasicThrottle: the window and Retry-After', () => {
  it.each([
    // [seconds between the five failures, Retry-After given with the fifth]
    [0, 600],
    [10, 590],
    [60, 540],
    [100, 500],
    [599, 1],
    // The oldest failure leaves 600 s after it; a part of a second counts as a whole one.
    [599.5, 1],
    [599.9999, 1],
  ])('five failures spread over %s s: Retry-After %i', (span, expected) => {
    const { throttle, advance } = setup()
    let answer: number | null = null
    for (let i = 0; i < 5; i++) {
      answer = throttle.recordFailure(ADDRESS, 'alice')
      if (i < 4) advance(span / 4)
    }
    expect(answer).toBe(expected)
  })

  it('counts down while the client keeps failing', () => {
    const { fail, advance } = setup()
    fail(ADDRESS, 'alice', 5)
    advance(100)
    expect(fail(ADDRESS, 'alice')).toEqual([500])
    advance(499.1)
    expect(fail(ADDRESS, 'alice')).toEqual([1])
  })

  it('treats a client that waited out Retry-After like a new one', () => {
    const { fail, advance } = setup()
    fail(ADDRESS, 'alice', 5)
    advance(599.9)
    // Still inside the window; the new failure also counts against it.
    expect(fail(ADDRESS, 'alice')).toEqual([1])
    advance(600)
    expect(fail(ADDRESS, 'alice', 4)).toEqual([null, null, null, null])
    expect(fail(ADDRESS, 'alice')).toEqual([600])
  })

  it('counts failures out one at a time: a sliding window, not a fixed one', () => {
    const { fail, advance } = setup()
    fail(ADDRESS, 'alice', 3)
    advance(300)
    // Five failures inside the window; the three old ones leave first, at +600.
    expect(fail(ADDRESS, 'alice', 2)).toEqual([null, 300])
    advance(300)
    // The three old ones are gone, the two newer ones count: three more reach five.
    expect(fail(ADDRESS, 'alice', 3)).toEqual([null, null, 300])
  })

  it('pushes the release back for a client that keeps failing while it is slowed down', () => {
    const { fail, advance } = setup()
    fail(ADDRESS, 'alice', 5) // free again at +600
    advance(500)
    // The failures at 0 leave one by one as new ones come in, until only new ones are left.
    expect(fail(ADDRESS, 'alice', 5)).toEqual([100, 100, 100, 100, 600])
  })

  it('releases when the fifth newest failure leaves the window, however many came in', () => {
    const { throttle, advance } = setup({ windowSec: 100 })
    for (let i = 0; i < 8; i++) {
      throttle.recordFailure(ADDRESS, 'alice')
      advance(10)
    }
    // Failures at 0, 10, ... 70 s and now one at 80 s: the newest five are 40 ... 80, so the count
    // drops below five when the one at 40 s leaves, at 140 s.
    expect(throttle.recordFailure(ADDRESS, 'alice')).toBe(60)
    expect(throttle.size().users).toBe(1)
  })

  it('never asks for more than the window, even if the clock jumped back', () => {
    const { fail, clock } = setup()
    fail(ADDRESS, 'alice', 5)
    clock.ms -= 3_600_000
    expect(fail(ADDRESS, 'alice')).toEqual([600])
  })

  it('uses the configured window', () => {
    const { fail, advance } = setup({ windowSec: 60 })
    expect(fail(ADDRESS, 'alice', 5).at(-1)).toBe(60)
    advance(60)
    expect(fail(ADDRESS, 'alice')).toEqual([null])
  })
})

describe('createBasicThrottle: success', () => {
  it('starts the (address, user name) counter over', () => {
    const { throttle, fail } = setup()
    fail(ADDRESS, 'alice', 4)
    throttle.recordSuccess(ADDRESS, 'Alice')
    expect(throttle.size().users).toBe(0)
    expect(fail(ADDRESS, 'alice', 5)).toEqual([null, null, null, null, 600])
  })

  it('also ends a block', () => {
    const { throttle, fail } = setup()
    expect(fail(ADDRESS, 'alice', 6).at(-1)).toBe(600)
    throttle.recordSuccess(ADDRESS, 'alice')
    expect(fail(ADDRESS, 'alice')).toEqual([null])
  })

  it('leaves the counters of other users and addresses alone', () => {
    const { throttle, fail } = setup()
    fail(ADDRESS, 'alice', 4)
    fail(ADDRESS, 'bob', 4)
    fail('198.51.100.7', 'alice', 4)
    throttle.recordSuccess(ADDRESS, 'ALICE')
    expect(fail(ADDRESS, 'bob')).toEqual([600])
    expect(fail('198.51.100.7', 'alice')).toEqual([600])
    expect(fail(ADDRESS, 'alice')).toEqual([null])
  })

  it('does not give back what the address spent', () => {
    const { throttle, fail } = setup({ addressBurst: 3 })
    fail(ADDRESS, 'a', 3)
    throttle.recordSuccess(ADDRESS, 'a')
    expect(fail(ADDRESS, 'b')).toEqual([1])
  })

  it('does nothing for a client that never failed', () => {
    const { throttle } = setup()
    throttle.recordSuccess(ADDRESS, 'alice')
    expect(throttle.size()).toEqual({ users: 0, addresses: 0 })
  })
})

describe('createBasicThrottle: the failure rate of an address', () => {
  it('lets an address fail 30 times at once, and answers with a wait from the 31st', () => {
    const { spray } = setup()
    const answers = spray(ADDRESS, 35)
    expect(answers.slice(0, 30)).toEqual(Array(30).fill(null))
    expect(answers.slice(30)).toEqual(Array(5).fill(1))
  })

  it('is a rate, not a block: a token is back after 100 ms and the bucket is full after 3 s', () => {
    const { spray, advance } = setup()
    spray(ADDRESS, 30)
    expect(spray(ADDRESS)).toEqual([1])
    advance(0.099)
    expect(spray(ADDRESS)).toEqual([1])
    advance(0.001)
    expect(spray(ADDRESS)).toEqual([null])
    expect(spray(ADDRESS)).toEqual([1])
    advance(3)
    expect(spray(ADDRESS, 30)).toEqual(Array(30).fill(null))
    expect(spray(ADDRESS)).toEqual([1])
  })

  it('sustains ten failures per second and no more', () => {
    const { spray, advance } = setup()
    spray(ADDRESS, 30)
    let allowed = 0
    for (let step = 0; step < 100; step++) {
      advance(0.1)
      // Twenty failures per second offered: every other one finds a token.
      allowed += spray(ADDRESS, 2).filter((answer) => answer === null).length
    }
    // 100 steps of 100 ms: ten seconds, ten tokens per second.
    expect(allowed).toBe(100)
  })

  it('does not charge for the failures it refuses', () => {
    const { spray, advance } = setup()
    spray(ADDRESS, 30)
    spray(ADDRESS, 1000)
    advance(0.1)
    expect(spray(ADDRESS)).toEqual([null])
  })

  it.each([
    // [burst, refill per second, seconds passed after emptying it, expected answer]
    [1, 10, 0, 1],
    [1, 0.5, 0, 2],
    [1, 0.5, 1, 1],
    [1, 0.5, 1.5, 1],
    [1, 0.5, 2, null],
    [5, 1, 0, 1],
    [5, 1, 0.5, 1],
    [5, 1, 1, null],
    [1, 0.01, 0, 100],
    [1, 0.01, 40, 60],
  ])(
    'with burst %i and %s tokens a second, %s s after it ran dry: %s',
    (burst, rate, passed, expected) => {
      const { spray, advance } = setup({ addressBurst: burst, addressRefillPerSec: rate })
      spray(ADDRESS, burst)
      advance(passed)
      expect(spray(ADDRESS)).toEqual([expected])
    },
  )

  it('asks for at least one second even when a token is a few milliseconds away', () => {
    const { spray, advance } = setup()
    spray(ADDRESS, 30)
    advance(0.095)
    expect(spray(ADDRESS)).toEqual([1])
  })

  it('keeps addresses apart', () => {
    const { spray } = setup()
    spray(ADDRESS, 30)
    expect(spray(ADDRESS)).toEqual([1])
    expect(spray('198.51.100.7')).toEqual([null])
  })

  it('gives the later wait when the user name and the address both ask for one', () => {
    // Bucket: 100 s to the next token. User: 600 s window.
    const { fail } = setup({ addressBurst: 5, addressRefillPerSec: 0.01 })
    expect(fail(ADDRESS, 'alice', 6)).toEqual([null, null, null, null, 600, 600])
    // The other way round: a short window, a slow bucket.
    const slow = setup({
      maxUserFailures: 2,
      addressBurst: 2,
      addressRefillPerSec: 0.01,
      windowSec: 50,
    })
    expect(slow.fail(ADDRESS, 'alice', 3)).toEqual([null, 50, 100])
  })

  it('does not refill on a clock that jumped back, and does not go negative', () => {
    const { spray, clock } = setup()
    spray(ADDRESS, 30)
    clock.ms -= 3_600_000
    expect(spray(ADDRESS)).toEqual([1])
    clock.ms += 100
    expect(spray(ADDRESS)).toEqual([null])
  })

  it.each([
    ['an IPv4 address', '203.0.113.9', '203.0.113.9'],
    ['an IPv6 address', '2001:db8::1', '2001:db8::1'],
    ['the same IPv6 address spelled out and in capitals', '2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['an IPv4-mapped IPv6 address', '::ffff:203.0.113.9', '203.0.113.9'],
    ['an IPv4-mapped IPv6 address in hex', '::FFFF:cb00:7109', '203.0.113.9'],
    ['an address with a zone id', 'fe80::1%eth0', 'fe80::1'],
  ])('counts %s together with its other spelling', (_name, spelled, other) => {
    const { spray } = setup({ addressBurst: 3 })
    spray(spelled, 2)
    expect(spray(other)).toEqual([null])
    expect(spray(spelled)).toEqual([1])
    expect(spray('198.51.100.7')).toEqual([null])
  })

  it('keeps different IPv6 addresses apart', () => {
    const { spray } = setup({ addressBurst: 1 })
    spray('2001:db8::1')
    expect(spray('2001:db8::2')).toEqual([null])
    expect(spray('2001:db8:0:1::1')).toEqual([null])
  })

  it.each([null, undefined, '', 'not an address', '999.1.1.1', '203.0.113.9:443', '[::1]:80'])(
    'puts the unusable address %j into one shared bucket',
    (address) => {
      const { spray } = setup({ addressBurst: 2 })
      spray(address, 2)
      expect(spray(null)).toEqual([1])
      expect(spray('203.0.113.9')).toEqual([null])
    },
  )
})

describe('createBasicThrottle: many clients and many user names', () => {
  it('slows down a client that tries many distinct user names, and keeps its memory in bounds', () => {
    const { throttle, spray, advance } = setup({ maxTrackedUsers: 50 })
    let slowedDown = 0
    for (let i = 0; i < 5000; i++) {
      if (spray(ADDRESS)[0] !== null) slowedDown++
      if (i % 100 === 99) advance(1)
      expect(throttle.size().users).toBeLessThanOrEqual(50)
    }
    // 30 at once, then ten a second: of 5000 failures over 50 s about 530 get through.
    expect(slowedDown).toBeGreaterThan(4400)
    expect(slowedDown).toBeLessThan(4500)
    expect(throttle.size().addresses).toBe(1)
  })

  it('stays within its bounds under a spray of addresses and user names', () => {
    const { throttle, fail, advance } = setup({ maxTrackedUsers: 50, maxTrackedAddresses: 40 })
    for (let i = 0; i < 5000; i++) {
      fail(`10.${i >> 8}.${i & 255}.1`, `user-${i}`)
      if (i % 700 === 0) advance(100)
      expect(throttle.size().users).toBeLessThanOrEqual(50)
      expect(throttle.size().addresses).toBeLessThanOrEqual(40)
    }
  })

  it('drops all expired user keys when that table is over its bound', () => {
    const { throttle, fail, advance } = setup({ maxTrackedUsers: 10 })
    for (let i = 0; i < 10; i++) fail(`198.51.100.${i}`, `user${i}`)
    expect(throttle.size().users).toBe(10)
    advance(601)
    fail(ADDRESS, 'alice')
    expect(throttle.size().users).toBe(1)
  })

  it('drops buckets that have refilled before the ones that still count', () => {
    const { throttle, spray, advance } = setup({ maxTrackedAddresses: 10 })
    for (let i = 0; i < 10; i++) spray(`198.51.100.${i}`)
    expect(throttle.size().addresses).toBe(10)
    advance(1)
    // One failure refilled to the top in 100 ms: the ten old buckets equal no bucket at all.
    spray(ADDRESS)
    expect(throttle.size().addresses).toBe(1)
  })

  it('makes room by dropping the address that failed longest ago when all of them still count', () => {
    const { throttle, spray } = setup({ maxTrackedAddresses: 3 })
    for (const address of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) spray(address, 30)
    spray('10.0.0.4', 30)
    expect(throttle.size().addresses).toBe(3)
    // The first one was forgotten (it gets a full bucket again); the others are still empty.
    expect(spray('10.0.0.1')).toEqual([null])
    expect(spray('10.0.0.3')).toEqual([1])
    expect(spray('10.0.0.4')).toEqual([1])
  })

  it('never lets one key hold more than its limit of timestamps', () => {
    const { throttle, failLast } = setup()
    expect(failLast(ADDRESS, 'alice', 100000)).toBe(600)
    expect(throttle.size()).toEqual({ users: 1, addresses: 1 })
  })

  it('cuts long user names in the key, so they cannot inflate it', () => {
    const { fail } = setup()
    const long = 'x'.repeat(8000)
    fail(ADDRESS, long, 4)
    // The key holds the first 128 characters (far beyond any real user name).
    expect(fail(ADDRESS, 'x'.repeat(128) + 'y')).toEqual([600])
    expect(fail(ADDRESS, 'x'.repeat(127))).toEqual([null])
  })

  it('tells user names with a line break from the address part of the key', () => {
    const { fail } = setup()
    fail(ADDRESS, 'alice\n198.51.100.7\nbob', 5)
    expect(fail('198.51.100.7', 'bob')).toEqual([null])
    expect(fail(ADDRESS, 'bob')).toEqual([null])
  })
})

describe('createBasicThrottle: reporting', () => {
  it('reports once when a user key reaches its limit, not on later failures', () => {
    const { blocks, fail } = setup()
    fail(ADDRESS, 'Alice', 4)
    expect(blocks).toEqual([])
    fail(ADDRESS, 'Alice', 1)
    expect(blocks).toEqual([
      { scope: 'user', address: ADDRESS, username: 'Alice', retryAfterSec: 600 },
    ])
    fail(ADDRESS, 'Alice', 20)
    expect(blocks).toHaveLength(1)
  })

  it('reports once for a run of rate-limited failures of an address, however long it lasts', () => {
    const { blocks, spray, advance } = setup()
    // 200 failures a second for ten seconds from one address.
    for (let step = 0; step < 100; step++) {
      spray('2001:0db8::1', 20)
      advance(0.1)
    }
    expect(blocks).toEqual([{ scope: 'address', address: '2001:db8::1', retryAfterSec: 1 }])
  })

  it('reports a new run after the address was quiet long enough to refill', () => {
    const { blocks, spray, advance } = setup()
    spray(ADDRESS, 40)
    advance(2)
    spray(ADDRESS, 40) // the bucket was not full yet: the same run
    expect(blocks.filter((block) => block.scope === 'address')).toHaveLength(1)
    advance(5)
    spray(ADDRESS, 40)
    expect(blocks.filter((block) => block.scope === 'address')).toHaveLength(2)
  })

  it('reports both when one failure completes both', () => {
    const { blocks, fail } = setup({ maxUserFailures: 2, addressBurst: 1 })
    fail(ADDRESS, 'alice', 1)
    fail(ADDRESS, 'alice', 1)
    expect(blocks.map((block) => block.scope)).toEqual(['user', 'address'])
  })

  it('reports again when a key is blocked anew after its window passed', () => {
    const { blocks, fail, advance } = setup()
    fail(ADDRESS, 'alice', 5)
    advance(601)
    fail(ADDRESS, 'alice', 5)
    expect(blocks.filter((block) => block.scope === 'user')).toHaveLength(2)
  })

  it('reports nothing for a block that a success ended', () => {
    const { blocks, throttle, fail } = setup()
    fail(ADDRESS, 'alice', 4)
    throttle.recordSuccess(ADDRESS, 'alice')
    fail(ADDRESS, 'alice', 4)
    expect(blocks).toEqual([])
  })

  it('does not turn a failing logger into a failing login', () => {
    const throttle = createBasicThrottle({
      onBlock: () => {
        throw new Error('stderr closed')
      },
    })
    for (let i = 0; i < 5; i++) throttle.recordFailure(ADDRESS, 'alice')
    expect(throttle.recordFailure(ADDRESS, 'alice')).not.toBeNull()
  })

  it('writes a line that holds the address, a short quoted user name and no line break', () => {
    const line = describeBlock({
      scope: 'user',
      address: ADDRESS,
      username: `${'x'.repeat(100)}\nFAKE LOG LINE`,
      retryAfterSec: 600,
    })
    expect(line).toContain(ADDRESS)
    expect(line).toContain(`"${'x'.repeat(64)}"`)
    expect(line).not.toContain('x'.repeat(65))
    expect(line).not.toContain('FAKE')
    expect(line).not.toMatch(/[\r\n]/)
    expect(
      describeBlock({ scope: 'user', address: ADDRESS, username: 'a\r\nb"c', retryAfterSec: 1 }),
    ).toContain('"a\\r\\nb\\"c"')
    const address = describeBlock({ scope: 'address', address: ADDRESS, retryAfterSec: 3 })
    expect(address).toContain(ADDRESS)
    expect(address).toContain('3 s')
    expect(address).toContain('correct logins are not affected')
  })
})

describe('createBasicThrottle: options', () => {
  it.each([
    ['maxUserFailures', 0],
    ['maxUserFailures', 1.5],
    ['windowSec', 0],
    ['windowSec', Number.NaN],
    ['addressBurst', 0],
    ['addressBurst', 2.5],
    ['addressRefillPerSec', 0],
    ['addressRefillPerSec', -1],
    ['addressRefillPerSec', Infinity],
    ['maxTrackedUsers', 0],
    ['maxTrackedAddresses', Infinity],
  ])('refuses %s = %s', (name, value) => {
    expect(() => createBasicThrottle({ [name]: value } as BasicThrottleOptions)).toThrow(TypeError)
  })

  it('works with the real clock', () => {
    const throttle = createBasicThrottle()
    const answers = Array.from({ length: 5 }, () => throttle.recordFailure(ADDRESS, 'alice'))
    expect(answers).toEqual([null, null, null, null, 600])
  })
})
