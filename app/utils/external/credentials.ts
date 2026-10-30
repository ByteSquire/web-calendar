// Getting a sealed credential and keeping it (FR-8). A password is typed once, sent to the app's
// server over the authenticated API, and comes back sealed (it opens only in the proxy, for this
// user, account and origin). The password is not kept anywhere here; the sealed text goes to the
// seal store. Used by the settings form (create, update) and by the password dialog (the
// credential route, for a new session or device or a refused login).
import type { ExternalAccountResult } from '../../../shared/types/external'
import type { ExternalApi } from './api'
import { describeExternalSaveError } from './api-errors'
import type { SealStore } from './seals'

/**
 * Keeps what a create, update or credential call returned. An account without a login has no
 * credential, so a copy it had goes. For an account with a login a missing `sealed` means the call
 * did not touch the credential (a rename): what is kept stays, only "remember" may change. Returns
 * whether the credential is now also on this device.
 */
export function keepResult(
  seals: Pick<SealStore, 'get' | 'set' | 'forget'>,
  result: ExternalAccountResult,
  remember: boolean,
): boolean {
  const { account, sealed } = result
  if (account.authMode !== 'basic') {
    seals.forget(account.id)
    return false
  }
  const kept = sealed ?? seals.get(account.id)
  return kept === null ? false : seals.set(account.id, kept, remember)
}

export type PasswordOutcome =
  | { ok: true; /** Also kept on this device. */ remembered: boolean }
  | { ok: false; message: string }

/** Seals `password` for an account and keeps the result. Never throws, never logs the error. */
export async function enterPassword(
  deps: { api: Pick<ExternalApi, 'setCredential'>; seals: SealStore },
  accountId: number,
  password: string,
  remember: boolean,
): Promise<PasswordOutcome> {
  try {
    const result = await deps.api.setCredential(accountId, password)
    if (result.account.authMode === 'basic' && result.sealed === null) {
      return { ok: false, message: 'The server did not return a credential. Try again.' }
    }
    return { ok: true, remembered: keepResult(deps.seals, result, remember) }
  } catch (cause) {
    // The error of the request carries the request, so only its words go on.
    const failure = describeExternalSaveError(cause, 'save the password')
    const message = failure.alert ?? Object.values(failure.byField)[0]
    return { ok: false, message: message ?? 'Could not save the password.' }
  }
}
