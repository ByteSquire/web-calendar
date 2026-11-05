import { getDb } from '../utils/db'
import { groupFilePath } from '../utils/groups/config'
import {
  clampAuditIntervalHours,
  clampReconcileIntervalSec,
  parseSharedOwners,
} from '../utils/sharing/config'
import { setActiveSharing } from '../utils/sharing'
import { createConsistencyAudit } from '../utils/sharing/audit-job'
import { createJobLoop } from '../utils/sharing/loop'
import { createFileMembership } from '../utils/sharing/membership'
import { createRadicaleClient } from '../utils/sharing/radicale-client'
import { createSharingReconciler } from '../utils/sharing/reconcile'

const DEBOUNCE_MS = 2000
const BACKOFF_BASE_MS = 5000
const AUDIT_DELAY_MS = 120_000

// Turns calendar_acl into Radicale shares (security review §7.1) and audits the result nightly.
// Off in demo mode and without a Radicale URL. Errors are handled inside a run; nothing here can
// stop the process.
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const config = useRuntimeConfig()
  const url = String(config.radicale.url ?? '').trim()
  if (!url || String(config.demo) === 'true') return

  const log = { warn: (m: string) => console.warn(m), error: (m: string) => console.error(m) }
  let client: ReturnType<typeof createRadicaleClient>
  try {
    client = createRadicaleClient({ baseUrl: url })
  } catch {
    console.error('[sharing] NUXT_RADICALE_URL is not a URL; the sharing writer is off')
    return
  }
  const intervalSec = clampReconcileIntervalSec(config.sharing.reconcileIntervalSec)
  if (String(config.sharing.reconcileIntervalSec).trim() !== String(intervalSec)) {
    console.warn(
      `[sharing] NUXT_SHARING_RECONCILE_INTERVAL_SEC is out of range; using ${intervalSec} s`,
    )
  }
  const auditHours = clampAuditIntervalHours(config.sharing.auditIntervalHours)
  const sharedOwners = parseSharedOwners(config.sharing.sharedOwners)
  const membership = createFileMembership(
    groupFilePath(config.groupsFile, process.env.NODE_ENV),
    (message) => console.warn(`[sharing] ${message}`),
  )

  let stop = () => {}
  nitroApp.hooks.hook('close', () => {
    stop()
    setActiveSharing(undefined)
  })

  // The database opens asynchronously (plugins/db.ts); the jobs need it.
  void (async () => {
    let db: ReturnType<typeof getDb> | undefined
    for (let i = 0; i < 120 && !db; i += 1) {
      try {
        db = getDb()
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (!db) {
      console.error('[sharing] the database did not open; the sharing writer is off')
      return
    }
    const reconciler = createSharingReconciler({ db, client, log, sharedOwners })
    const audit = createConsistencyAudit({ db, client, membership, log })
    const reconcileLoop = createJobLoop({
      run: async () => (await reconciler.run()).ok,
      intervalMs: intervalSec * 1000,
      debounceMs: DEBOUNCE_MS,
      backoffBaseMs: BACKOFF_BASE_MS,
    })
    const auditLoop = createJobLoop({
      run: async () => (await audit.run()).ok,
      intervalMs: auditHours * 3_600_000,
      debounceMs: DEBOUNCE_MS,
      backoffBaseMs: 600_000,
      initialDelayMs: AUDIT_DELAY_MS,
    })
    stop = () => {
      reconcileLoop.stop()
      auditLoop.stop()
    }
    setActiveSharing({ request: () => reconcileLoop.request(), state: () => reconciler.state() })
    reconcileLoop.start()
    auditLoop.start()
  })()
})
