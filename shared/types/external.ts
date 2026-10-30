// External CalDAV accounts (FR-8): the shapes the API and the browser share. The server stores the
// account's non-secret part; the secret (the password) is never stored there. For an account with a
// login the server hands the browser a SEALED credential: the password encrypted for this user, this
// account and this origin only. The browser keeps the sealed text and sends it with every request to
// the proxy, which opens it and forwards the login to the account's origin and nowhere else.

export type ExternalAuthMode = 'none' | 'basic'

/** Accounts one user may have. */
export const MAX_EXTERNAL_ACCOUNTS = 10

export const EXTERNAL_NAME_MAX_LENGTH = 80
export const EXTERNAL_URL_MAX_LENGTH = 2048
export const EXTERNAL_USERNAME_MAX_LENGTH = 256
export const EXTERNAL_PASSWORD_MAX_LENGTH = 1024

/** The request header that carries the sealed credential to the proxy: `Sealed <text>`. */
export const EXTERNAL_CREDENTIAL_HEADER = 'X-Upstream-Authorization'

/** The proxy's path prefix; the account id and the origin-relative path follow it. */
export const EXTERNAL_PROXY_PREFIX = '/api/external'

export interface ExternalAccount {
  id: number
  name: string
  /**
   * The account's CalDAV address: a calendar home, a principal or one calendar. Its origin is
   * what the proxy talks to. `https`, except for an account without a login on `http`.
   */
  url: string
  authMode: ExternalAuthMode
  /** `basic` only; the user name is not a secret. */
  username: string | null
  color: string | null
  createdAt: string
  updatedAt: string
}

export interface ExternalAccountInput {
  name: string
  url: string
  authMode: ExternalAuthMode
  username?: string | null
  /** `basic` only; used once to make the sealed credential and not kept. */
  password?: string | null
  color?: string | null
}

export interface ExternalAccountUpdate {
  name?: string
  url?: string
  authMode?: ExternalAuthMode
  username?: string | null
  /**
   * Required when the origin, the user name or the auth mode changes (the old seal is void).
   * Server: not needed when the change leaves the login (`authMode: 'none'`).
   */
  password?: string | null
  color?: string | null
}

/**
 * Answer of create, update and the credential route. `sealed` is null for `authMode: 'none'`.
 * Server: it is also null for an update of a login that changes nothing the seal depends on (a
 * rename, a color, a path on the same origin): keep the seal you have.
 */
export interface ExternalAccountResult {
  account: ExternalAccount
  sealed: string | null
}

/** `GET /api/external-accounts` */
export interface ExternalAccountList {
  accounts: ExternalAccount[]
  /** False when the server has no seal key: accounts with a login cannot be added. */
  loginsEnabled: boolean
}

/** Added to every answer that comes from the account's server: the status it really gave. */
export const EXTERNAL_UPSTREAM_STATUS_HEADER = 'X-Upstream-Status'

/**
 * `data.code` of a failed account API call: a 400 (`logins_disabled`: no seal key on the server;
 * `credential_required`: the change needs `password`; `host_not_allowed`: the address is not on the
 * administrator's list or is a private one; `invalid_url`: any problem with `url`, `data.fields`
 * says which) or a 409 (`limit_reached`, `duplicate`).
 */
export type ExternalApiErrorCode =
  | 'logins_disabled'
  | 'credential_required'
  | 'host_not_allowed'
  | 'invalid_url'
  | 'limit_reached'
  | 'duplicate'

/**
 * `{ "error": <code> }`, the proxy's own failures (the account's server was not asked, or its
 * answer was not usable). None of them carries `X-Upstream-Status`, except `upstream_login_failed`
 * (502, status 401): a 401 from the proxy always means the app's own token is bad.
 *   400 `invalid_path`, `invalid_request` · 405 `method_not_allowed` · 403 `host_not_allowed` ·
 *   404 `account_not_found` · 411 `length_required` · 413 `request_too_large` ·
 *   428 `credential_required` (send `X-Upstream-Authorization`, or ask for the password again) ·
 *   429 `rate_limited` (`Retry-After`) · 502 `upstream_login_failed`, `redirect_refused`,
 *   `bad_response`, `unreachable`, `timeout`, `too_large`
 */
export type ExternalProxyError =
  | 'invalid_path'
  | 'invalid_request'
  | 'method_not_allowed'
  | 'host_not_allowed'
  | 'account_not_found'
  | 'length_required'
  | 'request_too_large'
  | 'credential_required'
  | 'rate_limited'
  | 'upstream_login_failed'
  | 'redirect_refused'
  | 'bad_response'
  | 'unreachable'
  | 'timeout'
  | 'too_large'
