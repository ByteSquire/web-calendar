// The shapes of the API the settings screen talks to (server/api/me.get.ts, app-tokens/**,
// ical-subscriptions/**). They are written out here instead of imported from the server so the
// browser bundle stays free of server code; the server tests pin the real shapes.

/** What `useAuthFetch()` returns: `$fetch` with the bearer token. */
export type ApiFetch = typeof $fetch

export interface MeResponse {
  id: number
  sub: string
  username: string | null
  name: string | null
  email: string | null
  isAdmin: boolean
  timeZone: string | null
}

export interface TokenListItem {
  id: number
  label: string
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  /** Decided by the server, not recomputed from the browser's clock. */
  expired: boolean
}

export interface TokenList {
  tokens: TokenListItem[]
  /** Unexpired tokens one user may have. */
  limit: number
}

export interface CreatedToken {
  id: number
  label: string
  /** The secret; the server sends it once. */
  token: string
  expiresAt: string
}

export interface Subscription {
  id: number
  /** The calendar ref the rest of the app uses (`ics:<id>`). */
  ref: string
  name: string
  url: string
  /** `#rrggbb`, or null when none was chosen. */
  color: string | null
  /** Offered to everybody; read-only. */
  shared: boolean
}

export interface SubscriptionInput {
  name: string
  url: string
  color: string
}
