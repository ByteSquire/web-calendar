import { openDatabase } from '../db/connection'
import type { Migration } from '../db/migrate'
import { upgradeDatabase } from '../db/upgrade'
import { setDb } from '../utils/db'

// Nitro bundles server/db/migrations as the server asset "migrations" (see nuxt.config.ts), so the
// files are present in .output as well as in dev.
async function loadBundledMigrations(): Promise<Migration[]> {
  const assets = useStorage('assets:migrations')
  const names = (await assets.getKeys()).filter((key) => key.endsWith('.sql'))
  if (names.length === 0) throw new Error('no .sql files in the server asset "migrations"')
  return Promise.all(
    names.map(async (name) => {
      const sql = await assets.getItem(name)
      if (typeof sql !== 'string') throw new Error(`cannot read the migration ${name}`)
      return { name, sql }
    }),
  )
}

export default defineNitroPlugin((nitroApp) => {
  // The build renders the SPA shell through this server; it needs no database.
  if (import.meta.prerender) return

  const { dbPath } = useRuntimeConfig()

  async function start(): Promise<void> {
    const db = openDatabase(dbPath)
    try {
      // The database of an earlier version is copied and migrated here, before the first request.
      const { applied, backup } = upgradeDatabase(db, dbPath, await loadBundledMigrations())
      if (backup) console.info(`[db] Copied the database to ${backup} before upgrading it`)
      if (applied.length > 0) console.info(`[db] Applied migrations: ${applied.join(', ')}`)
    } catch (error) {
      db.close()
      throw error
    }
    setDb(db)
    nitroApp.hooks.hook('close', () => {
      db.close()
    })
  }

  // Nitro does not wait for plugins, so a failed start has to stop the process itself, and
  // requests wait for the start to finish.
  const ready = start().catch((error: unknown) => {
    console.error(
      `[db] Cannot start the database at "${dbPath}": ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  })
  nitroApp.hooks.hook('request', () => ready)
})
