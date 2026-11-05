// The sign-in window (NUXT_SIGNIN_WINDOW_DAYS): how long after their last sign-in a person still
// counts as active. It bounds the app tokens and the group of everyone, nothing else.

export const DEFAULT_SIGNIN_WINDOW_DAYS = 30
export const MIN_SIGNIN_WINDOW_DAYS = 1
export const MAX_SIGNIN_WINDOW_DAYS = 365

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The number of days in a setting value. An empty value means the default; anything but a whole
 * number from 1 to 365 throws, so a typo stops the server at start instead of widening or
 * shrinking the window silently.
 */
export function parseSigninWindowDays(value: unknown): number {
  const text = String(value ?? '').trim()
  if (text === '') return DEFAULT_SIGNIN_WINDOW_DAYS
  const days = /^[0-9]{1,4}$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isInteger(days) || days < MIN_SIGNIN_WINDOW_DAYS || days > MAX_SIGNIN_WINDOW_DAYS) {
    throw new Error(
      `NUXT_SIGNIN_WINDOW_DAYS must be a whole number of days from ${MIN_SIGNIN_WINDOW_DAYS} to ${MAX_SIGNIN_WINDOW_DAYS}`,
    )
  }
  return days
}

/** The window in milliseconds, from the setting value. */
export function signinWindowMsOf(value: unknown): number {
  return parseSigninWindowDays(value) * DAY_MS
}

/**
 * The oldest `users.last_seen_at` that is inside the window at `now`, as the ISO string
 * `last_seen_at` is stored in (`toISOString()`; the column default is the same shape), so that
 * `last_seen_at >= cutoff` compares the strings as times. A person seen exactly at the cutoff is
 * still inside.
 */
export function signinCutoff(windowMs: number, now: Date): string {
  return new Date(now.getTime() - windowMs).toISOString()
}

let configured: number | undefined

/** The window of this server, read once from the runtime configuration. */
export function signinWindowMs(): number {
  configured ??= signinWindowMsOf(useRuntimeConfig().signinWindowDays)
  return configured
}
