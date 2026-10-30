// The loader's progress as the UI reads it. Backed by the same state container as the calendar
// state (Nuxt `useState` in the app, a plain ref map in tests).
import type { Ref } from 'vue'
import type { ExternalAccount } from '../../../shared/types/external'
import type { StateFactory } from '../calendar-state'

export interface LiveStatusState {
  /** A load (sources or events) is running. */
  loading: Ref<boolean>
  /**
   * What could not be loaded, by calendar id (`dav:...`, `ics:...`, `ext:...`) or by source key
   * (`source:views`, `source:external:<id>`, see errors.ts), as a short message.
   */
  errors: Ref<Record<string, string>>
  /** Per calendar: entries that were left out because they could not be read. */
  skipped: Ref<Record<string, number>>
  /** The external accounts as last read: the problems list names them, the dialog asks for them. */
  externalAccounts: Ref<ExternalAccount[]>
  /** Problems of `errors` that a new password cures: key -> the external account's id. */
  passwordFor: Ref<Record<string, number>>
  /** Epoch milliseconds of the last finished load of events; null before the first. */
  lastLoadedAt: Ref<number | null>
}

export function createLiveStatusState(state: StateFactory): LiveStatusState {
  return {
    loading: state<boolean>('live-loading', () => false),
    errors: state<Record<string, string>>('live-errors', () => ({})),
    skipped: state<Record<string, number>>('live-skipped', () => ({})),
    externalAccounts: state<ExternalAccount[]>('live-external-accounts', () => []),
    passwordFor: state<Record<string, number>>('live-password-for', () => ({})),
    lastLoadedAt: state<number | null>('live-last-loaded', () => null),
  }
}
