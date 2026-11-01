import { getDb } from '../utils/db'
import { repairBlocks } from '../utils/resources/service'
import { setBlockStore } from '../utils/resources/store'
import { createResourceBlockStore } from '../utils/sharing/block-store'

const REPAIR_EVERY_MS = 10 * 60_000
const FIRST_REPAIR_DELAY_MS = 60_000

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
  nitroApp.hooks.hook('close', () => {
    clearTimeout(first)
    clearInterval(timer)
    setBlockStore(undefined)
  })
})
