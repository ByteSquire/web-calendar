import type { Database } from 'better-sqlite3'
import {
  EXTERNAL_PASSWORD_MAX_LENGTH,
  type ExternalAccount,
  type ExternalAccountList,
  type ExternalAccountResult,
} from '../../../shared/types/external'
import {
  createExternalAccount,
  deleteExternalAccount,
  ExternalAccountError,
  findExternalAccount,
  listExternalAccounts,
  updateExternalAccount,
  type StoredExternalAccount,
} from '../../db/external-accounts'
import { conflict, found, notFound, toBadRequest } from '../api/errors'
import { FieldErrors, isRecord, readObject } from '../api/validation'
import { IcalFetchError } from '../ical-proxy/errors'
import { hostnameOf, hostRefusal, resolveAllowed, type AddressPolicy } from '../ical-proxy/ssrf'
import {
  expectValidAccount,
  parseExternalAccountInput,
  type ExternalAccountInputOptions,
} from './account-input'
import { credentialRequired, externalError, loginsDisabled } from './errors'
import type { Sealer } from './seal'

// The account endpoints as plain functions around server/db/external-accounts.ts: validation, the
// host policy, sealing and the mapping of the store's errors to API errors. The routes only call
// these. Nothing here contacts the account's server, and no password outlives a call: it goes into
// a seal (server/utils/external/seal.ts) and the seal goes to the browser.

export interface AccountDeps {
  db: Database
  policy: AddressPolicy
  /** Null without NUXT_EXTERNAL_SEAL_KEY: accounts with a login are refused. */
  sealer: Sealer | null
  /** A login over plain http; tests and local development only. */
  allowInsecureLogins: boolean
}

/** The caller, as far as accounts need to know: the row id and the subject the seals are bound to. */
export interface AccountUser {
  id: number
  sub: string
}

function inputOptions(deps: AccountDeps): ExternalAccountInputOptions {
  return { allowInsecureLogins: deps.allowInsecureLogins }
}

/**
 * The host policy for an address a user entered: the administrator's list, then (when `resolve`)
 * the SSRF rules on what the name resolves to now. The proxy checks again on every request: a
 * name can point somewhere else later, and the list can change.
 */
async function requireAllowedHost(
  origin: string,
  policy: AddressPolicy,
  resolve: boolean,
): Promise<void> {
  const host = hostnameOf(new URL(origin))
  try {
    if (resolve) await resolveAllowed(host, policy)
    else {
      const refusal = hostRefusal(host, policy)
      if (refusal) throw refusal
    }
  } catch (error) {
    if (!(error instanceof IcalFetchError)) throw error
    if (error.reason === 'blocked') {
      throw externalError('host_not_allowed', 'The address is not allowed', [
        {
          field: 'url',
          message: error.notListed
            ? 'must name a host that the administrator allows'
            : 'must not point to a private or reserved network',
        },
      ])
    }
    throw externalError('invalid_url', 'The address cannot be reached', [
      { field: 'url', message: 'has a host name that cannot be resolved' },
    ])
  }
}

function toApiError(error: unknown): unknown {
  return error instanceof ExternalAccountError ? conflict(error.code, error.message) : error
}

function seal(
  sealer: Sealer,
  user: AccountUser,
  stored: StoredExternalAccount,
  password: string,
): string {
  return sealer.seal(
    { username: stored.account.username!, password },
    { sub: user.sub, accountId: stored.account.id, origin: stored.origin },
  )
}

export function listAccounts(
  db: Database,
  sealer: Sealer | null,
  userId: number,
): ExternalAccountList {
  return { accounts: listExternalAccounts(db, userId), loginsEnabled: sealer !== null }
}

export async function addAccount(
  deps: AccountDeps,
  user: AccountUser,
  body: unknown,
): Promise<ExternalAccountResult> {
  const { fields, password } = expectValidAccount(
    parseExternalAccountInput(body, inputOptions(deps)),
  )
  const basic = fields.authMode === 'basic'
  if (basic && !deps.sealer) throw loginsDisabled()
  if (basic && password === null) throw credentialRequired()
  await requireAllowedHost(fields.origin, deps.policy, true)

  let stored: StoredExternalAccount
  try {
    stored = createExternalAccount(deps.db, user.id, fields)
  } catch (error) {
    throw toApiError(error)
  }
  return {
    account: stored.account,
    sealed: basic ? seal(deps.sealer!, user, stored, password!) : null,
  }
}

/**
 * The stored account with the changes of `body` laid over it. A field left out stays; `null`
 * clears an optional one. Without a login there is no user name, so leaving the login behind
 * drops it unless the body says otherwise.
 */
function mergeUpdate(current: ExternalAccount, body: unknown): unknown {
  if (!isRecord(body)) return body
  const merged: Record<string, unknown> = {
    name: current.name,
    url: current.url,
    authMode: current.authMode,
    username: current.username,
    color: current.color,
  }
  for (const key of ['name', 'url', 'authMode', 'username', 'color', 'password']) {
    if (body[key] !== undefined) merged[key] = body[key]
  }
  if (merged.authMode === 'none' && body.username === undefined) merged.username = null
  return merged
}

/** 404 for a missing id and someone else's alike. */
export async function changeAccount(
  deps: AccountDeps,
  user: AccountUser,
  id: number,
  body: unknown,
): Promise<ExternalAccountResult> {
  const current = found(findExternalAccount(deps.db, user.id, id))
  const { fields, password } = expectValidAccount(
    parseExternalAccountInput(mergeUpdate(current.account, body), inputOptions(deps)),
  )
  const basic = fields.authMode === 'basic'
  if (basic && !deps.sealer) throw loginsDisabled()

  // The old seal is void when the origin, the user name or the login itself changed (it is bound to
  // the origin, and the proxy compares the user name). Leaving the login behind needs no password.
  const sealVoid =
    basic &&
    (current.account.authMode !== 'basic' ||
      current.origin !== fields.origin ||
      current.account.username !== fields.username)
  if (sealVoid && password === null) throw credentialRequired()

  // The list is checked on every change; the name is resolved only for a new address, so a
  // rename works while the account's server is down.
  await requireAllowedHost(fields.origin, deps.policy, current.origin !== fields.origin)

  let stored: StoredExternalAccount | null
  try {
    stored = updateExternalAccount(deps.db, user.id, id, fields)
  } catch (error) {
    throw toApiError(error)
  }
  const updated = found(stored)
  // `sealed` is null when nothing needs sealing: no login, or a login the browser's seal still fits.
  return {
    account: updated.account,
    sealed: basic && password !== null ? seal(deps.sealer!, user, updated, password) : null,
  }
}

/**
 * A new seal for an existing account (a new device, a cleared browser). The password is not
 * checked against the account's server: nothing is contacted. 404 for a missing id and someone
 * else's alike.
 */
export function resealAccount(
  deps: AccountDeps,
  user: AccountUser,
  id: number,
  body: unknown,
): ExternalAccountResult {
  const stored = found(findExternalAccount(deps.db, user.id, id))
  if (stored.account.authMode !== 'basic') {
    throw toBadRequest([
      { field: 'password', message: 'is not used by an account without a login' },
    ])
  }
  if (!deps.sealer) throw loginsDisabled()

  const errors = new FieldErrors()
  const { password } = readObject(body, errors)
  if (password === undefined || password === null || password === '') {
    errors.add('password', 'is required')
  } else if (typeof password !== 'string') {
    errors.add('password', 'must be a string')
  } else if (password.length > EXTERNAL_PASSWORD_MAX_LENGTH) {
    errors.add('password', `must have at most ${EXTERNAL_PASSWORD_MAX_LENGTH} characters`)
  }
  if (!errors.ok || typeof password !== 'string') throw toBadRequest(errors.toArray())
  return { account: stored.account, sealed: seal(deps.sealer, user, stored, password) }
}

export function removeAccount(db: Database, userId: number, id: number): void {
  if (!deleteExternalAccount(db, userId, id)) throw notFound()
}
