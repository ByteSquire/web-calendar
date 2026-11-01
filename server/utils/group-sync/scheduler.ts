// Runs the sync at a fixed pause after the previous run ended (so runs never overlap) and on
// request. Requests are coalesced: one run after a short delay, or right after the running one.

export interface SchedulerTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface GroupSyncSchedulerOptions {
  run(): Promise<unknown>
  intervalMs: number
  debounceMs: number
  timers?: SchedulerTimers
}

export interface GroupSyncScheduler {
  /** Runs once now, then every interval. */
  start(): void
  stop(): void
  /** Asks for a run soon; many calls within the delay make one run. */
  request(): void
}

const realTimers: SchedulerTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return handle
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export function createGroupSyncScheduler(options: GroupSyncSchedulerOptions): GroupSyncScheduler {
  const timers = options.timers ?? realTimers
  let timer: unknown
  let started = false
  let running = false
  let pending = false
  let requested = false

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
    try {
      await options.run()
    } catch {
      // The run reports its own failures; nothing may stop the schedule.
    } finally {
      running = false
    }
    if (!started) return
    if (pending) {
      pending = false
      requested = true
      schedule(options.debounceMs)
    } else {
      schedule(options.intervalMs)
    }
  }

  return {
    start() {
      if (started) return
      started = true
      void tick()
    },
    stop() {
      started = false
      if (timer !== undefined) timers.clear(timer)
      timer = undefined
    },
    request() {
      if (!started) return
      if (running) {
        pending = true
      } else if (!requested) {
        requested = true
        schedule(options.debounceMs)
      }
    },
  }
}
