import { getDb } from '../utils/db'
import { createAppPorts } from '../utils/group-sync/app-ports'
import { createGroupsTracker, setActiveGroupSync } from '../utils/group-sync/active'
import { clampIntervalSec, groupFilePath } from '../utils/group-sync/config'
import { createKanidmClient, kanidmOrigin, type KanidmClient } from '../utils/group-sync/kanidm'
import { createKanidmResolver } from '../utils/group-sync/members'
import { createGroupSyncScheduler } from '../utils/group-sync/scheduler'
import { createGroupSyncService } from '../utils/group-sync/service'

const DEBOUNCE_MS = 2000

// Fills Radicale's group file (security review §7.2). With a Kanidm token it also reads the groups
// from Kanidm and imports them. Without one (app-only mode) the file holds the app's own groups and
// nothing is read from Kanidm, so no token is revoked. Never in demo mode. Errors are handled inside
// a run; nothing here can stop the process.
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const config = useRuntimeConfig()
  if (String(config.demo) === 'true') return
  const token = String(config.groupSync.token ?? '').trim()

  let client: KanidmClient | null = null
  if (token) {
    const origin = kanidmOrigin(config.oidc.issuer)
    if (!origin) {
      console.error('[group-sync] NUXT_OIDC_ISSUER is not a URL; the group sync is off')
      return
    }
    client = createKanidmClient({ origin, token })
  } else {
    console.warn(
      '[group-sync] NUXT_GROUP_SYNC_TOKEN is not set: the group file holds the app-made groups only',
    )
  }
  const intervalSec = clampIntervalSec(config.groupSync.intervalSec)
  if (String(config.groupSync.intervalSec).trim() !== String(intervalSec)) {
    console.warn(
      `[group-sync] NUXT_GROUP_SYNC_INTERVAL_SEC is out of range; using ${intervalSec} s`,
    )
  }

  const service = createGroupSyncService({
    client,
    resolver: client ? createKanidmResolver(client) : null,
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

  // The database opens asynchronously (plugins/db.ts); the first run needs it (access rules, app
  // tokens).
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
