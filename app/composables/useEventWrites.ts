// Creating, editing and deleting events on the calendar service (FR-9), bound to the app: the
// CalDAV client and reader of the session (plugins/caldav.client.ts), the loader's `refresh` and
// the viewer's time zones. The logic and its tests are in app/utils/writes/. In demo mode and
// wherever the plugin does not run `live` is false and the dialogs keep their Phase 1 behaviour.
import { computed } from 'vue'
import { useCalDav } from '~/composables/useCalDav'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { t } from '~/utils/i18n'
import { isLiveConfig } from '~/utils/live/seed'
import {
  createEvent,
  deleteEvent,
  editEvent,
  type DeleteArgs,
  type EditArgs,
} from '~/utils/writes/orchestrate'
import type { NewEventInput } from '~/utils/ical/write'
import type { WriteDeps, WriteFailure, WriteOutcome } from '~/utils/writes/types'

const notAvailable = (): WriteFailure => ({
  kind: 'unknown',
  message: t('The calendar service is not available.'),
  reload: false,
  closeForm: false,
})

export function useEventWrites() {
  const config = useServerConfigState()
  const caldav = useCalDav()
  const { refresh } = useLiveStatus()
  const displayTimeZone = useDisplayTimeZone()
  const orgTimeZone = useOrgTimeZone()

  const deps: WriteDeps | null = caldav
    ? {
        client: caldav.client,
        reader: caldav.reader,
        // A write reloads the built-in calendars; the external accounts' servers are not asked.
        refresh: () => refresh({ external: false }),
        zones: () => ({
          displayTimeZone: displayTimeZone.value,
          orgTimeZone: orgTimeZone.value,
        }),
      }
    : null

  /** True when events are written to the calendar service, false for the in-memory demo. */
  const live = computed(() => isLiveConfig(config.value) && deps !== null)

  // The original error text is for whoever debugs; the person sees the sentence.
  async function run<T extends object>(
    work: (deps: WriteDeps) => Promise<WriteOutcome<T>>,
  ): Promise<WriteOutcome<T>> {
    if (!deps) return { ok: false, failure: notAvailable() }
    const outcome = await work(deps)
    if (!outcome.ok && outcome.failure.detail) {
      console.warn(`Writing the event failed (${outcome.failure.kind}):`, outcome.failure.detail)
    }
    return outcome
  }

  return {
    live,
    create: (args: { calendarHref: string; input: NewEventInput }) =>
      run((d) => createEvent(d, args)),
    edit: (args: EditArgs) => run((d) => editEvent(d, args)),
    remove: (args: DeleteArgs) => run((d) => deleteEvent(d, args)),
  }
}
