import { getDb } from '../utils/db'
import { signinWindowMs } from '../utils/auth/window'
import { groupFilePath } from '../utils/groups/config'
import { setActiveGroupFile } from '../utils/groups/file-trigger'
import { createGroupFileService } from '../utils/groups/file-service'
import { createJobLoop } from '../utils/sharing/loop'

const DEBOUNCE_MS = 2000
const BACKOFF_BASE_MS = 5000
/** People age out of the line of everyone with the clock, so the file is rewritten hourly. */
const INTERVAL_MS = 60 * 60 * 1000

// Writes Radicale's group file from the database (design §8): at start, when groups, members or
// the people of the last days change, and hourly. Never in demo mode. Errors are handled inside a
// run; nothing here can stop the process, except a sign-in window that is not a number of days.
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const config = useRuntimeConfig()
  if (String(config.demo) === 'true') return

  const service = createGroupFileService({
    getDb,
    file: groupFilePath(config.groupsFile, process.env.NODE_ENV),
    windowMs: signinWindowMs(),
    log: console,
  })
  const loop = createJobLoop({
    run: () => service.run(),
    intervalMs: INTERVAL_MS,
    debounceMs: DEBOUNCE_MS,
    backoffBaseMs: BACKOFF_BASE_MS,
  })
  setActiveGroupFile({
    request: () => loop.request(),
    noteActive: (sub) => {
      if (!service.listed(sub)) loop.request()
    },
  })
  nitroApp.hooks.hook('close', () => {
    loop.stop()
    setActiveGroupFile(undefined)
  })

  // The database opens asynchronously (plugins/db.ts); the first write needs it.
  void (async () => {
    for (let i = 0; i < 120; i += 1) {
      try {
        getDb()
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    loop.start()
  })()
})
