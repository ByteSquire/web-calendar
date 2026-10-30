import type { Database } from 'better-sqlite3'
import {
  createIcalSubscription,
  deleteIcalSubscription,
  findVisibleIcalSubscription,
  IcalSubscriptionError,
  updateIcalSubscription,
  type IcalSubscription,
} from '../../db/ical-subscriptions'
import { conflict, found, notFound, toBadRequest } from '../api/errors'
import { expectValid } from '../api/validation'
import { IcalFetchError } from './errors'
import { hostnameOf, resolveAllowed, type AddressPolicy } from './ssrf'
import { parseSubscriptionInput } from './subscription-input'

// The subscription endpoints as plain functions around server/db/ical-subscriptions.ts: input
// validation, the SSRF check of the address and the mapping of the store's errors to API errors.
// The routes only call these.

/**
 * Resolves the host now so the user gets an immediate answer. The fetch checks again every time:
 * a name can point somewhere else later.
 */
async function requireAllowedHost(url: string, policy: AddressPolicy): Promise<void> {
  try {
    await resolveAllowed(hostnameOf(new URL(url)), policy)
  } catch (error) {
    if (!(error instanceof IcalFetchError)) throw error
    throw toBadRequest([
      {
        field: 'url',
        message:
          error.reason === 'blocked'
            ? 'must not point to a private or reserved network'
            : 'has a host name that cannot be resolved',
      },
    ])
  }
}

function toApiError(error: unknown): unknown {
  return error instanceof IcalSubscriptionError ? conflict(error.code, error.message) : error
}

export async function addSubscription(
  db: Database,
  policy: AddressPolicy,
  userId: number,
  body: unknown,
): Promise<IcalSubscription> {
  const input = expectValid(parseSubscriptionInput(body))
  await requireAllowedHost(input.url, policy)
  try {
    return createIcalSubscription(db, userId, input)
  } catch (error) {
    throw toApiError(error)
  }
}

/** 404 for a missing id, someone else's and a shared one alike. */
export async function changeSubscription(
  db: Database,
  policy: AddressPolicy,
  userId: number,
  id: number,
  body: unknown,
): Promise<IcalSubscription> {
  const current = found(findVisibleIcalSubscription(db, userId, id))
  if (current.shared) throw notFound()
  const input = expectValid(parseSubscriptionInput(body))
  // A rename must work while the source is down, so only a new address is resolved.
  if (input.url !== current.url) await requireAllowedHost(input.url, policy)
  try {
    return found(updateIcalSubscription(db, userId, id, input))
  } catch (error) {
    throw toApiError(error)
  }
}

export function removeSubscription(db: Database, userId: number, id: number): void {
  if (!deleteIcalSubscription(db, userId, id)) throw notFound()
}
