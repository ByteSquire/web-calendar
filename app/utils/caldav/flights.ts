// Two small concurrency tools: requests that several callers want at the same time run once
// ("flights"), and the number of requests running at once is capped ("limiter"). Both honour
// `AbortSignal`s: the shared request is cancelled only when every caller has given up, and a caller
// that gives up while still queued never causes a request.
import { DavError } from './errors'

const abortedError = () => new DavError('aborted', 'the request was aborted')

interface Flight<T> {
  promise: Promise<T>
  controller: AbortController
  waiters: number
  settled: boolean
}

export interface Flights<T> {
  /**
   * The result of `start`, shared by every caller with the same `key`. `start` gets the signal of
   * the shared request. Each caller's own `signal` only ends that caller's wait (rejecting with an
   * `aborted` error); the shared request is aborted when no caller is left. `fresh` starts a new
   * request even if one is running (the old one keeps serving its own callers).
   */
  join(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    options?: { signal?: AbortSignal; fresh?: boolean },
  ): Promise<T>
  /** Stop sharing running requests whose key starts with `prefix`; they still finish for their callers. */
  drop(prefix: string): void
}

export function createFlights<T>(): Flights<T> {
  const flights = new Map<string, Flight<T>>()

  function begin(key: string, start: (signal: AbortSignal) => Promise<T>): Flight<T> {
    const controller = new AbortController()
    const flight: Flight<T> = {
      promise: Promise.resolve().then(() => start(controller.signal)),
      controller,
      waiters: 0,
      settled: false,
    }
    flights.set(key, flight)
    const finish = () => {
      flight.settled = true
      if (flights.get(key) === flight) flights.delete(key)
    }
    flight.promise.then(finish, finish)
    return flight
  }

  return {
    join(key, start, options = {}) {
      const { signal, fresh = false } = options
      if (signal?.aborted) return Promise.reject(abortedError())
      let flight = fresh ? undefined : flights.get(key)
      if (!flight) flight = begin(key, start)
      const joined = flight
      joined.waiters++

      return new Promise<T>((resolve, reject) => {
        let done = false
        const leave = () => {
          done = true
          signal?.removeEventListener('abort', onAbort)
          joined.waiters--
        }
        function onAbort() {
          if (done) return
          leave()
          if (joined.waiters === 0 && !joined.settled) {
            if (flights.get(key) === joined) flights.delete(key)
            joined.controller.abort()
          }
          reject(abortedError())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        joined.promise.then(
          (value) => {
            if (done) return
            leave()
            resolve(value)
          },
          (error: unknown) => {
            if (done) return
            leave()
            reject(error)
          },
        )
      })
    },

    drop(prefix) {
      for (const key of [...flights.keys()]) {
        if (key.startsWith(prefix)) flights.delete(key)
      }
    },
  }
}

export interface Limiter {
  /** Runs `task` when fewer than `limit` tasks are running. Rejects `aborted` if `signal` fires first. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

export function createLimiter(limit: number): Limiter {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('concurrency must be at least 1')
  let running = 0
  const queue: { wake: () => void }[] = []

  function release() {
    running--
    queue.shift()?.wake()
  }

  return {
    async run(task, signal) {
      if (signal?.aborted) throw abortedError()
      if (running >= limit) {
        await new Promise<void>((resolve, reject) => {
          const entry = {
            wake: () => {
              signal?.removeEventListener('abort', onAbort)
              running++
              resolve()
            },
          }
          function onAbort() {
            const at = queue.indexOf(entry)
            if (at !== -1) queue.splice(at, 1)
            reject(abortedError())
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          queue.push(entry)
        })
      } else {
        running++
      }
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}
