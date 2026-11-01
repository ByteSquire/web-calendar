export const BOOKING_DEFAULT_RECONCILE_SEC = 300
export const BOOKING_MAX_RECONCILE_SEC = 900

/** The configured seconds, clamped to 1..900; anything unreadable means the default. */
export function clampBookingReconcileIntervalSec(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(value) || value < 1) return BOOKING_DEFAULT_RECONCILE_SEC
  return Math.min(Math.floor(value), BOOKING_MAX_RECONCILE_SEC)
}
