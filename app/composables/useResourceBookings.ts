// The data of the page "Resource bookings" (FR-19): pending requests to decide for managers, the
// viewer's own bookings to cancel. Live mode asks the resource routes; demo mode keeps the rows
// in local state and makes no request. The viewer's rights decide what is shown; the routes check.
import { Temporal } from 'temporal-polyfill'
import type { BookingRequestsResponse } from '../../shared/types/resources-api'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { N_, t, tc } from '~/utils/i18n'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { isLiveConfig } from '~/utils/live/seed'
import { describeDecisionFailure } from '~/utils/resources/errors'
import {
  acceptLocal,
  fromListedBooking,
  fromRequest,
  ownBookings,
  pendingRequests,
  seedDemoRows,
  setStatusLocal,
  withOverlaps,
  type BookingRow,
} from '~/utils/resources/rows'
import type { AcceptAnswer, ApiBooking, ApiResource } from '~/utils/resources/types'
import { describeError } from '~/utils/settings/api-errors'

export type DecisionResult = { ok: true; message: string } | { ok: false; message: string }

export function useResourceBookings() {
  const live = isLiveConfig(useServerConfigState().value)
  const api = useAuthFetch()
  const { refresh } = useLiveStatus()
  const zone = useDisplayTimeZone()

  /** Demo rows: they outlive the page (a booking made in the form shows up here). */
  const demoRows = useState<BookingRow[] | null>('demo-booking-rows', () => null)
  const liveRows = ref<BookingRow[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref('')
  /** Manages at least one resource (known once loaded; always in demo mode). */
  const manages = ref(!live)

  if (!live && demoRows.value === null) {
    demoRows.value = seedDemoRows(Temporal.Now.plainDateISO(zone.value), zone.value)
  }

  const rows = computed(() => (live ? liveRows.value : (demoRows.value ?? [])))
  const requests = computed(() => pendingRequests(rows.value))
  const mine = computed(() => ownBookings(rows.value, new Date()))

  async function load(): Promise<void> {
    if (!live) {
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const [requestAnswer, resourceAnswer, me] = await Promise.all([
        api<BookingRequestsResponse>('/api/resources/requests'),
        api<{ resources: ApiResource[] }>('/api/resources'),
        api<{ id: number }>('/api/me'),
      ])
      const own = await Promise.all(
        resourceAnswer.resources
          .filter((resource) => resource.right !== 'read')
          .map(async (resource) => {
            const answer = await api<{ bookings: ApiBooking[] }>(
              `/api/resources/${resource.id}/bookings`,
            )
            return answer.bookings.flatMap(
              (booking) =>
                fromListedBooking(
                  booking,
                  { id: String(resource.id), name: resource.name },
                  me.id,
                ) ?? [],
            )
          }),
      )
      manages.value = resourceAnswer.resources.some((resource) => resource.right === 'manage')
      liveRows.value = [...requestAnswer.requests.map(fromRequest), ...own.flat()]
      loaded.value = true
    } catch (cause) {
      error.value = describeError(cause, N_('load the bookings'))
    } finally {
      loading.value = false
    }
  }

  /** The calendar shows the new state of the resource at once. */
  function reloadCalendar(): void {
    if (live) void refresh({ external: false })
  }

  async function post(row: BookingRow, action: 'accept' | 'decline' | 'cancel') {
    return api<AcceptAnswer | { booking: ApiBooking }>(
      `/api/resources/${row.resourceId}/bookings/${row.id}/${action}`,
      { method: 'POST' },
    )
  }

  function dropRows(ids: ReadonlySet<number>): void {
    liveRows.value = liveRows.value.filter((item) => !ids.has(item.id))
  }

  async function accept(row: BookingRow): Promise<DecisionResult> {
    if (!live) {
      const result = acceptLocal(demoRows.value ?? [], row.id)
      demoRows.value = result.rows
      return { ok: true, message: acceptMessage(row, result.declined.length) }
    }
    try {
      const answer = (await post(row, 'accept')) as AcceptAnswer
      dropRows(new Set([row.id, ...answer.declined.map((item) => item.id)]))
      reloadCalendar()
      return { ok: true, message: acceptMessage(row, answer.declined.length) }
    } catch (cause) {
      // The request was decided elsewhere or is gone: show what the server has now.
      void load()
      return { ok: false, message: describeDecisionFailure(cause, 'accept') }
    }
  }

  async function decide(row: BookingRow, action: 'decline' | 'cancel'): Promise<DecisionResult> {
    const done = action === 'decline' ? 'declined' : 'cancelled'
    const message =
      action === 'decline'
        ? t('Booking of {name} declined.', { name: row.resourceName })
        : t('Booking of {name} cancelled.', { name: row.resourceName })
    if (!live) {
      demoRows.value = setStatusLocal(demoRows.value ?? [], row.id, done)
      return { ok: true, message }
    }
    try {
      await post(row, action)
      dropRows(new Set([row.id]))
      reloadCalendar()
      return { ok: true, message }
    } catch (cause) {
      void load()
      return { ok: false, message: describeDecisionFailure(cause, action) }
    }
  }

  /** Demo mode: a booking made in the event form, waiting for approval like a real one. */
  function addDemoBooking(args: {
    resourceId: string
    resourceName: string
    start: string
    end: string
    requesterName: string
  }): void {
    if (live) return
    const nextId = Math.max(9000, ...(demoRows.value ?? []).map((row) => row.id)) + 1
    demoRows.value = withOverlaps([
      ...(demoRows.value ?? []),
      {
        id: nextId,
        ...args,
        status: 'pending',
        mine: true,
        createdAt: new Date().toISOString(),
        orphaned: false,
        overlapIds: [],
      },
    ])
  }

  return {
    live,
    requests,
    mine,
    loaded,
    manages,
    loading,
    error,
    load,
    accept,
    decline: (row: BookingRow) => decide(row, 'decline'),
    cancel: (row: BookingRow) => decide(row, 'cancel'),
    addDemoBooking,
  }
}

function acceptMessage(row: BookingRow, declined: number): string {
  const name = row.resourceName
  if (declined === 0) return t('Booking of {name} approved.', { name })
  return tc(
    'Booking of {name} approved. {count} overlapping request was declined and the requesters were told. | Booking of {name} approved. {count} overlapping requests were declined and the requesters were told.',
    declined,
    { name },
  )
}
