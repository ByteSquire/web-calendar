// The external accounts as the live loader sees them (FR-8, design §7 "External accounts"): the
// list of accounts from the app, the calendars of one account (discovery) and the events of its
// calendars (the reader, with its 30 s cache). Everything for an account goes through that
// account's proxy `fetch` (proxy-fetch.ts), which is the only code that can reach its server.
//
// Per account there is one client and one reader (so one cache and one limit of 3 requests at a
// time); they are made again when the account is edited. All accounts together share one limit on
// requests in flight, because the proxy allows a user a burst of 60 requests and 20 per second.
import type { ExternalAccount, ExternalAccountList } from '../../../shared/types/external'
import { createCalDavClient } from '../caldav/client'
import { DavError } from '../caldav/errors'
import { createLimiter } from '../caldav/flights'
import {
  createCalendarReader,
  type CalendarReader,
  type ReadCalendar,
  type ReadResult,
} from '../caldav/reader'
import type { DavCalendar, DavRange } from '../caldav/types'
import type { ExternalApi } from './api'
import { discoverCalendars } from './discovery'
import { accountOrigin, createProxyFetch } from './proxy-fetch'
import type { SealStore } from './seals'

/** Requests of one account at a time. */
export const ACCOUNT_CONCURRENCY = 3

/** Requests of all accounts together. */
export const TOTAL_CONCURRENCY = 6

export interface ExternalSource {
  /** The user's accounts and whether the server can seal passwords. */
  listAccounts: () => Promise<ExternalAccountList>
  /** The calendars behind an account's address. Rejects with a `DavError`. */
  listCalendars: (account: ExternalAccount, signal?: AbortSignal) => Promise<DavCalendar[]>
  /** The events of calendars of one account; one result per calendar, never rejects. */
  read: (
    account: ExternalAccount,
    calendars: readonly ReadCalendar[],
    range: DavRange,
    options?: { signal?: AbortSignal; force?: boolean },
  ) => Promise<ReadResult[]>
}

export interface ExternalSourceOptions {
  /** The app's `fetch` with its bearer token, its login failure worded as a `DavError`. */
  fetch: typeof fetch
  api: Pick<ExternalApi, 'list'>
  seals: Pick<SealStore, 'get' | 'forget' | 'sync'>
}

interface Entry {
  /** What the entry was made for; another value means the account was edited. */
  signature: string
  fetch: typeof fetch
  reader: CalendarReader
}

export function createExternalSource(options: ExternalSourceOptions): ExternalSource {
  const limiter = createLimiter(TOTAL_CONCURRENCY)
  const entries = new Map<number, Entry>()

  function entryFor(account: ExternalAccount): Entry {
    const signature = [account.url, account.authMode, account.updatedAt].join('\n')
    const existing = entries.get(account.id)
    if (existing?.signature === signature) return existing

    const proxy = createProxyFetch({
      account,
      fetch: (input, init) =>
        limiter.run(() => options.fetch(input, init), init?.signal ?? undefined),
      sealed: () => options.seals.get(account.id),
      // The proxy cannot open the seal any more: asking again is the only way on.
      // Only the seal that failed: a request that waited in the queue may report a seal that has
      // been replaced since, and the new one must stay.
      onCredentialVoid: (used) => {
        if (options.seals.get(account.id) === used) options.seals.forget(account.id)
      },
    })
    // Hrefs the account's server returns are pinned to its origin by the client, as for the
    // built-in service. The server expands nothing: external servers differ in whether they
    // honour `expand`, so the events reader expands series itself (see the loader).
    const client = createCalDavClient({ baseUrl: accountOrigin(account.url), fetch: proxy })
    const reader = createCalendarReader(client, {
      ttlMs: 30_000,
      concurrency: ACCOUNT_CONCURRENCY,
      padDays: 1,
    })
    const entry: Entry = { signature, fetch: proxy, reader }
    entries.set(account.id, entry)
    return entry
  }

  return {
    async listAccounts() {
      const list = await options.api.list()
      options.seals.sync(list.accounts.map((account) => account.id))
      // Accounts that are gone take their clients and caches with them.
      const ids = new Set(list.accounts.map((account) => account.id))
      for (const id of [...entries.keys()]) if (!ids.has(id)) entries.delete(id)
      return list
    },

    async listCalendars(account, signal) {
      return discoverCalendars({
        url: account.url,
        fetch: entryFor(account).fetch,
        fallbackName: account.name,
        ...(signal ? { signal } : {}),
      })
    },

    async read(account, calendars, range, readOptions) {
      let entry: Entry
      try {
        entry = entryFor(account)
      } catch (cause) {
        // An address that has no origin: every calendar of the account fails, nothing else does.
        const error = new DavError('bad-response', 'the account’s address cannot be used', {
          cause,
        })
        return calendars.map((calendar) => ({ calendarUrl: calendar.url, error }))
      }
      return entry.reader.read(calendars, range, readOptions)
    },
  }
}
