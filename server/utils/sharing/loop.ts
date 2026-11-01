// Runs a job at a fixed pause after the previous run ended (runs never overlap), sooner after a
// request (debounced), and with exponential backoff while the job fails.

export interface LoopTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface JobLoopOptions {
  /** Resolves true when the run went well; false makes the next run come sooner (backoff). */
  run(): Promise<boolean>
  intervalMs: number
  debounceMs: number
  backoffBaseMs: number
  /** Pause before the first run. */
  initialDelayMs?: number
  timers?: LoopTimers
}

export interface JobLoop {
  start(): void
  stop(): void
  /** Asks for a run soon; many calls within the delay make one run. */
  request(): void
}

const realTimers: LoopTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return handle
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** The pause after `failures` failed runs in a row: base, 2x base, ... never above the interval. */
export function backoffDelay(failures: number, baseMs: number, intervalMs: number): number {
  return Math.min(intervalMs, baseMs * 2 ** Math.min(Math.max(failures - 1, 0), 20))
}

export function createJobLoop(options: JobLoopOptions): JobLoop {
  const timers = options.timers ?? realTimers
  let timer: unknown
  let started = false
  let running = false
  let pending = false
  let requested = false
  let failures = 0

  function schedule(ms: number): void {
    if (timer !== undefined) timers.clear(timer)
    timer = timers.set(() => void tick(), ms)
  }

  async function tick(): Promise<void> {
    timer = undefined
    requested = false
    if (!started) return
    if (running) {
      pending = true
      return
    }
    running = true
    let ok = false
    try {
      ok = await options.run()
    } catch {
      // The job reports its own failures; nothing may stop the schedule.
    } finally {
      running = false
    }
    failures = ok ? 0 : failures + 1
    if (!started) return
    if (pending) {
      pending = false
      requested = true
      schedule(options.debounceMs)
    } else {
      schedule(
        ok ? options.intervalMs : backoffDelay(failures, options.backoffBaseMs, options.intervalMs),
      )
    }
  }

  return {
    start() {
      if (started) return
      started = true
      if (options.initialDelayMs) schedule(options.initialDelayMs)
      else void tick()
    },
    stop() {
      started = false
      if (timer !== undefined) timers.clear(timer)
      timer = undefined
    },
    request() {
      if (!started) return
      if (running) pending = true
      else if (!requested) {
        requested = true
        schedule(options.debounceMs)
      }
    },
  }
}
