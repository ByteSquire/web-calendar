// @vitest-environment node
// The CalDAV sighting: a bearer call is recorded and refreshed in the background, at most every five
// minutes per person, with bounded memory and parallel work, and never at the request's expense.
import { describe, expect, it, vi } from 'vitest'
import {
  SIGHTING_INTERVAL_MS,
  SIGHTING_MAX_PARALLEL,
  createSightingTracker,
} from '../../server/utils/groups/sighting'

const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.secret-payload.secret-signature'

function setup(options: { maxPeople?: number; maxParallel?: number } = {}) {
  const clock = { ms: 1_000_000 }
  const calls: { sub: string; token: string }[] = []
  const gates: (() => void)[] = []
  const errors: unknown[] = []
  const refresh = vi.fn(async (sub: string, token: string) => {
    calls.push({ sub, token })
    await new Promise<void>((resolve) => gates.push(resolve))
  })
  const tracker = createSightingTracker({
    refresh,
    onError: (error) => errors.push(error),
    now: () => clock.ms,
    ...options,
  })
  const finishAll = async () => {
    while (gates.length > 0) gates.pop()!()
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { tracker, clock, calls, errors, refresh, finishAll }
}

describe('createSightingTracker', () => {
  it('refreshes a person at once, with their own token, and returns without waiting', async () => {
    const { tracker, calls, finishAll } = setup()
    tracker.note('alice', TOKEN, undefined)
    await Promise.resolve()
    expect(calls).toEqual([{ sub: 'alice', token: TOKEN }])
    expect(tracker.running()).toBe(1)
    await finishAll()
    expect(tracker.running()).toBe(0)
  })

  it('refreshes a person at most once in five minutes', async () => {
    const { tracker, clock, refresh, finishAll } = setup()
    tracker.note('alice', TOKEN, undefined)
    await finishAll()
    clock.ms += SIGHTING_INTERVAL_MS - 1
    tracker.note('alice', TOKEN, undefined)
    await finishAll()
    expect(refresh).toHaveBeenCalledTimes(1)
    clock.ms += 1
    tracker.note('alice', TOKEN, undefined)
    await finishAll()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps people apart', async () => {
    const { tracker, refresh, finishAll } = setup()
    tracker.note('alice', TOKEN, undefined)
    tracker.note('bob', TOKEN, undefined)
    await finishAll()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('runs at most four at once, and a skipped person is tried again by their next request', async () => {
    const { tracker, refresh, finishAll } = setup()
    expect(SIGHTING_MAX_PARALLEL).toBe(4)
    for (const sub of ['a', 'b', 'c', 'd', 'e']) tracker.note(sub, TOKEN, undefined)
    await Promise.resolve()
    expect(tracker.running()).toBe(4)
    expect(refresh).toHaveBeenCalledTimes(4)
    await finishAll()
    // 'e' was skipped without using up its turn.
    tracker.note('e', TOKEN, undefined)
    await finishAll()
    expect(refresh).toHaveBeenCalledTimes(5)
  })

  it('forgets everybody when the memory is full instead of growing', async () => {
    const { tracker, finishAll } = setup({ maxPeople: 3 })
    for (const sub of ['a', 'b', 'c']) tracker.note(sub, TOKEN, undefined)
    await finishAll()
    expect(tracker.size()).toBe(3)
    tracker.note('d', TOKEN, undefined)
    await finishAll()
    expect(tracker.size()).toBe(1)
  })

  it('never throws into the request, whether refresh throws, rejects or the logger breaks', async () => {
    const throwing = createSightingTracker({
      refresh: () => {
        throw new Error('sync failure')
      },
      onError: () => {
        throw new Error('broken logger')
      },
    })
    expect(() => throwing.note('alice', TOKEN, undefined)).not.toThrow()
    const rejecting = setup()
    rejecting.refresh.mockRejectedValueOnce(new Error('database is down'))
    rejecting.tracker.note('alice', TOKEN, undefined)
    await rejecting.finishAll()
    expect(rejecting.errors).toHaveLength(1)
    expect(rejecting.tracker.running()).toBe(0)
  })

  it('does not put the token anywhere but into the call that needs it', async () => {
    const { tracker, errors, refresh, finishAll } = setup()
    refresh.mockRejectedValueOnce(new Error('userinfo failed'))
    tracker.note('alice', TOKEN, undefined)
    await finishAll()
    expect(JSON.stringify(errors.map(String))).not.toContain('secret-payload')
    expect(JSON.stringify(tracker)).not.toContain('secret-payload')
  })
})
