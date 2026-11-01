import { getDb } from '../utils/db'
import { createAppPorts } from '../utils/group-sync/app-ports'
import { createGroupsTracker, setActiveGroupSync } from '../utils/group-sync/active'
import { clampIntervalSec, groupFilePath } from '../utils/group-sync/config'
import { createKanidmClient, kanidmOrigin } from '../utils/group-sync/kanidm'
import { createUsersTableResolver } from '../utils/group-sync/members'
import { createGroupSyncScheduler } from '../utils/group-sync/scheduler'
import { createGroupSyncService } from '../utils/group-sync/service'

const DEBOUNCE_MS = 2000

// Fills Radicale's group file from Kanidm (security review §7.2). Only with a token, never in
// demo mode. Errors are handled inside a run; nothing here can stop the process.
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const config = useRuntimeConfig()
  const token = String(config.groupSync.token ?? '').trim()
  if (!token || String(config.demo) === 'true') return

  const origin = kanidmOrigin(config.oidc.issuer)
  if (!origin) {
    console.error('[group-sync] NUXT_OIDC_ISSUER is not a URL; the group sync is off')
    return
  }
  const intervalSec = clampIntervalSec(config.groupSync.intervalSec)
  if (String(config.groupSync.intervalSec).trim() !== String(intervalSec)) {
    console.warn(
      `[group-sync] NUXT_GROUP_SYNC_INTERVAL_SEC is out of range; using ${intervalSec} s`,
    )
  }

  const service = createGroupSyncService({
    client: createKanidmClient({ origin, token }),
    resolver: () => createUsersTableResolver(getDb()),
    ports: createAppPorts(getDb, console),
    log: console,
    file: groupFilePath(config.groupSync.file, process.env.NODE_ENV),
    adminGroup: config.oidc.adminGroup,
  })
  const scheduler = createGroupSyncScheduler({
    run: () => service.run(),
    intervalMs: intervalSec * 1000,
    debounceMs: DEBOUNCE_MS,
  })
  const tracker = createGroupsTracker(() => scheduler.request())
  setActiveGroupSync({ request: () => scheduler.request(), note: (s, g) => tracker.note(s, g) })
  nitroApp.hooks.hook('close', () => {
    scheduler.stop()
    setActiveGroupSync(undefined)
  })

  // The database opens asynchronously (plugins/db.ts); the first run needs its users table.
  void (async () => {
    for (let i = 0; i < 120; i += 1) {
      try {
        getDb()
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    scheduler.start()
  })()
})
