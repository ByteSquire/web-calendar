export const DEFAULT_RECONCILE_INTERVAL_SEC = 300
export const MAX_RECONCILE_INTERVAL_SEC = 900
export const DEFAULT_AUDIT_INTERVAL_HOURS = 24
export const MAX_AUDIT_INTERVAL_HOURS = 168

function toNumber(raw: unknown): number {
  return typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
}

/** The configured seconds, clamped to 1..900; anything unreadable means the default. */
export function clampReconcileIntervalSec(raw: unknown): number {
  const value = toNumber(raw)
  if (!Number.isFinite(value) || value < 1) return DEFAULT_RECONCILE_INTERVAL_SEC
  return Math.min(Math.floor(value), MAX_RECONCILE_INTERVAL_SEC)
}

/** The configured hours, clamped to 1..168; anything unreadable means the default. */
export function clampAuditIntervalHours(raw: unknown): number {
  const value = toNumber(raw)
  if (!Number.isFinite(value) || value < 1) return DEFAULT_AUDIT_INTERVAL_HOURS
  return Math.min(Math.floor(value), MAX_AUDIT_INTERVAL_HOURS)
}

const SERVICE_OWNER = /^_[A-Za-z0-9_.-]{1,63}$/

/** The service principals to mirror, sorted and unique; invalid entries and `_resources` dropped. */
export function parseSharedOwners(raw: unknown): string[] {
  const entries = String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => SERVICE_OWNER.test(entry) && entry !== '_resources')
  return [...new Set(entries)].sort()
}
