import { getDb } from '../utils/db'
import { repairBlocks } from '../utils/resources/service'
import { setBlockStore } from '../utils/resources/store'
import { createBookingReconciler } from '../utils/resources/reconcile'
import { clampBookingReconcileIntervalSec } from '../utils/resources/reconcile-config'
import { createBookingEventReader } from '../utils/resources/reconcile-reader'
import { createResourceBlockStore } from '../utils/sharing/block-store'
import { createJobLoop } from '../utils/sharing/loop'

const REPAIR_EVERY_MS = 10 * 60_000
const FIRST_REPAIR_DELAY_MS = 60_000
const FIRST_RECONCILE_DELAY_MS = 90_000
const RECONCILE_BACKOFF_MS = 30_000

// Writes the availability blocks of resource bookings into Radicale as the `_resources` service
// principal, and repairs the ones a failed write left behind. Off in demo mode and without Radicale.
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const config = useRuntimeConfig()
  if (!String(config.radicale.url ?? '').trim() || String(config.demo) === 'true') return

  let store: ReturnType<typeof createResourceBlockStore>
  try {
    store = createResourceBlockStore()
  } catch {
    console.error('[resources] NUXT_RADICALE_URL is not a URL; availability blocks are off')
    return
  }
  setBlockStore(store)

  let running = false
  async function repair(): Promise<void> {
    if (running) return
    running = true
    try {
      const result = await repairBlocks({ db: getDb(), store, log: (m) => console.warn(m) })
      if (result.failed > 0) {
        console.warn(`[resources] ${result.failed} availability block(s) could not be written`)
      }
    } catch (error) {
      console.warn(
        `[resources] block repair failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    } finally {
      running = false
    }
  }

  const first = setTimeout(() => void repair(), FIRST_REPAIR_DELAY_MS)
  const timer = setInterval(() => void repair(), REPAIR_EVERY_MS)
  // Looks at the events of active bookings when their calendar changed (design §5). Runs never
  // overlap (the loop waits for the run) and a failure only delays the next one.
  const intervalSec = clampBookingReconcileIntervalSec(config.resources?.reconcileIntervalSec)
  if (String(config.resources?.reconcileIntervalSec ?? '300').trim() !== String(intervalSec)) {
    console.warn(
      `[resources] NUXT_RESOURCES_RECONCILE_INTERVAL_SEC is out of range; using ${intervalSec} s`,
    )
  }
  const reader = createBookingEventReader({ baseUrl: String(config.radicale.url) })
  let reconciler: ReturnType<typeof createBookingReconciler> | undefined
  const reconcileLoop = createJobLoop({
    run: async () => {
      try {
        // The database opens asynchronously (plugins/db.ts); getDb throws until it has.
        reconciler ??= createBookingReconciler({
          db: getDb(),
          reader,
          store,
          log: (m) => console.warn(m),
        })
        const summary = await reconciler.run()
        if (summary.cancelled > 0 || summary.moved > 0) {
          console.warn(
            `[resources] booking reconcile: ${summary.cancelled} cancelled, ${summary.moved} moved`,
          )
        }
        return true
      } catch (error) {
        console.warn(
          `[resources] booking reconcile failed: ${error instanceof Error ? error.name : 'error'}`,
        )
        return false
      }
    },
    intervalMs: intervalSec * 1000,
    debounceMs: 2000,
    backoffBaseMs: RECONCILE_BACKOFF_MS,
    initialDelayMs: FIRST_RECONCILE_DELAY_MS,
  })
  reconcileLoop.start()

  nitroApp.hooks.hook('close', () => {
    clearTimeout(first)
    clearInterval(timer)
    reconcileLoop.stop()
    setBlockStore(undefined)
  })
})
