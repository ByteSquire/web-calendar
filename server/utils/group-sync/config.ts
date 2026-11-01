// Settings of the group sync. The interval is a security setting: a removed member keeps access
// for up to one interval, so it has a hard ceiling that the runtime enforces as well as
// server/validate-config.mjs.

export const DEFAULT_INTERVAL_SEC = 60
export const MAX_INTERVAL_SEC = 300

/** Always read: everyone who may use the app, and the admins come from `oidc.adminGroup`. */
export const USERS_GROUP = 'web_calendar_users'

/** The configured seconds, clamped to 1..300; anything unreadable means the default. */
export function clampIntervalSec(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(value) || value < 1) return DEFAULT_INTERVAL_SEC
  return Math.min(Math.floor(value), MAX_INTERVAL_SEC)
}

/** The group file: the configured path, else /groups/htgroup in production and .data/htgroup. */
export function groupFilePath(configured: unknown, nodeEnv: string | undefined): string {
  const path = typeof configured === 'string' ? configured.trim() : ''
  if (path) return path
  return nodeEnv === 'production' ? '/groups/htgroup' : '.data/htgroup'
}
