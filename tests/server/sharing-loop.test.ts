// @vitest-environment node
// The job loop of the sharing writer and the group file: runs at a pause, sooner after a request,
// and with backoff while the job fails. A request must not cut the backoff short.
import { describe, expect, it } from 'vitest'
import { backoffDelay, createJobLoop } from '../../server/utils/sharing/loop'

function fakeTimers() {
  const scheduled: { fn: () => void; ms: number }[] = []
  return {
    scheduled,
    timers: {
      set: (fn: () => void, ms: number) => {
        const entry = { fn, ms }
        scheduled.push(entry)
        return entry
      },
      clear: (handle: unknown) => {
        const index = scheduled.indexOf(handle as (typeof scheduled)[number])
        if (index >= 0) scheduled.splice(index, 1)
      },
    },
    /** The delay of the one timer that is waiting. */
    waiting: () => scheduled.map((entry) => entry.ms),
    fire: async () => {
      const entry = scheduled.shift()
      entry?.fn()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

const OPTIONS = { intervalMs: 3_600_000, debounceMs: 2000, backoffBaseMs: 5000 }

describe('createJobLoop', () => {
  it('waits the interval after a good run, and the debounce after a request', async () => {
    const t = fakeTimers()
    const loop = createJobLoop({ ...OPTIONS, run: async () => true, timers: t.timers })
    loop.start()
    await new Promise((resolve) => setImmediate(resolve))
    expect(t.waiting()).toEqual([3_600_000])
    loop.request()
    expect(t.waiting()).toEqual([2000])
  })

  it('backs off while the job fails, and a request does not make it retry sooner', async () => {
    const t = fakeTimers()
    const loop = createJobLoop({ ...OPTIONS, run: async () => false, timers: t.timers })
    loop.start()
    await new Promise((resolve) => setImmediate(resolve))
    expect(t.waiting()).toEqual([5000])
    // A person who is not in the file yet keeps asking for a write: the wait stays at the backoff.
    loop.request()
    loop.request()
    expect(t.waiting()).toEqual([5000])
    await t.fire()
    expect(t.waiting()).toEqual([backoffDelay(2, 5000, 3_600_000)])
    loop.request()
    expect(t.waiting()).toEqual([10_000])
  })

  it('goes back to the short debounce once a run is good again', async () => {
    const t = fakeTimers()
    let good = false
    const loop = createJobLoop({ ...OPTIONS, run: async () => good, timers: t.timers })
    loop.start()
    await new Promise((resolve) => setImmediate(resolve))
    good = true
    await t.fire()
    expect(t.waiting()).toEqual([3_600_000])
    loop.request()
    expect(t.waiting()).toEqual([2000])
  })
})
