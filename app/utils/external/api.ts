// The app's routes for external CalDAV accounts (FR-8): `/api/external-accounts`. The server keeps
// the non-secret part of an account and seals the password; the answers that carry a sealed
// credential (`ExternalAccountResult.sealed`) are for the seal store, nobody else. `api` is the
// authenticated `$fetch` (`useAuthFetch()`). A failed call throws ofetch's `FetchError`, which
// holds the request options and so the password: callers must not log it (utils/external/api-errors.ts
// words it).
import type {
  ExternalAccountInput,
  ExternalAccountList,
  ExternalAccountResult,
  ExternalAccountUpdate,
} from '../../../shared/types/external'
import type { ApiFetch } from '../settings/types'

export interface ExternalApi {
  list: () => Promise<ExternalAccountList>
  create: (input: ExternalAccountInput) => Promise<ExternalAccountResult>
  update: (id: number, input: ExternalAccountUpdate) => Promise<ExternalAccountResult>
  /** Seals the password again, for example on a new device. */
  setCredential: (id: number, password: string) => Promise<ExternalAccountResult>
  remove: (id: number) => Promise<void>
}

const ROUTE = '/api/external-accounts'

export function createExternalApi(api: ApiFetch): ExternalApi {
  return {
    list: () => api<ExternalAccountList>(ROUTE),
    create: (input) => api<ExternalAccountResult>(ROUTE, { method: 'POST', body: input }),
    update: (id, input) =>
      api<ExternalAccountResult>(`${ROUTE}/${id}`, { method: 'PUT', body: input }),
    setCredential: (id, password) =>
      api<ExternalAccountResult>(`${ROUTE}/${id}/credential`, {
        method: 'POST',
        body: { password },
      }),
    async remove(id) {
      await api(`${ROUTE}/${id}`, { method: 'DELETE' })
    },
  }
}
