<!--
  Quick-add and Add dialog (FR-24, FR-9). The layout always mounts it; it is open while
  `quickAddOpen` is set in useCalendarState(). It is one dialog in two sizes, told apart by
  `quickAddFull`: "Quick add" (the top bar, a click on a date) is lean, title, calendar, start and
  end and a repeat rule; "Add" (the top bar) adds the folding "Details" (location, description)
  and the resources to book with the event. Each time it opens, the form starts from
  `quickAddPreset` (or from the anchor date, 09:00 to 10:00) and validates on submit; after a
  failed submit the messages follow the input live. Form model, defaults and validation:
  app/utils/quick-add.ts and app/utils/writes/event-form.ts.

  On live data the event is written to a writable calendar of the calendar service (with
  description, location and a repeat rule); the dialog stays open with the reason when that
  fails. In demo mode it is added to the in-memory store, as in Phase 1.
-->
<template>
  <UModal
    :open="quickAddOpen"
    :title="quickAddFull ? t('Add event') : t('Quick add')"
    :description="t('Create an event')"
    :content="{ onOpenAutoFocus: focusTitle, onCloseAutoFocus: restoreFocus }"
    @update:open="onOpenChange"
  >
    <template #body>
      <form
        id="quick-add-form"
        ref="formElement"
        novalidate
        class="flex flex-col gap-4"
        :aria-busy="pending"
        :inert="saved"
        @submit.prevent="onSubmit"
      >
        <FormAlert :message="submitError" />
        <p
          v-if="noWritableCalendar"
          class="rounded-lg border border-default bg-elevated p-3 text-sm"
        >
          {{
            t('None of your calendars can take new events. Ask for a calendar you can write to.')
          }}
        </p>

        <EventFormFields
          ref="fields"
          v-model="form"
          mode="create"
          :errors="errors"
          :extended="live"
          :details="quickAddFull"
          :calendars="choosableCalendars"
          :time-zone="timeZone"
        />
        <ResourceBookingFields
          v-if="quickAddFull"
          v-model="chosenResources"
          :offered="bookable"
          :note="isSeries && chosenResources.length > 0 ? tv(SERIES_NOTE) : ''"
          :disabled="pending"
        />
      </form>
    </template>

    <template #footer>
      <div v-if="saved" class="flex w-full justify-end gap-2">
        <UButton :label="t('Close')" @click="closeQuickAdd()" />
      </div>
      <div v-else class="flex w-full flex-wrap items-center justify-end gap-2">
        <BookRightAwayCheckbox
          v-if="chosenResources.length > 0 && !isSeries"
          v-model="bookNow"
          :disabled="pending"
          class="me-auto"
        />
        <UButton :label="t('Cancel')" color="neutral" variant="outline" @click="closeQuickAdd()" />
        <UButton
          type="submit"
          form="quick-add-form"
          :label="t('Add event')"
          :loading="pending"
          :disabled="noWritableCalendar"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { N_, t, tv } from '~/utils/i18n'
import { Temporal } from 'temporal-polyfill'
import type { CalendarEvent } from '../../shared/types/calendar'
import { eventOverlapsRange } from '~/utils/calendar-state'
import { toNewEventInput } from '~/utils/quick-add'
import {
  initialEventForm,
  toWallClockRange,
  toWriterNewEvent,
  validateEventForm,
  type EventForm,
} from '~/utils/writes/event-form'
import { slotOf } from '~/utils/resources/slot'
import { SUCCESS_TITLES } from '~/utils/writes/messages'
import { writableCalendars } from '~/utils/writes/rules'

const {
  quickAddOpen,
  quickAddPreset,
  quickAddFull,
  closeQuickAdd,
  calendars,
  calendarById,
  visibleCalendarIds,
  anchorDate,
  visibleRange,
  addEvent,
} = useCalendarState()
useBackDismiss(quickAddOpen, closeQuickAdd)
const toast = useToast()
const timeZone = useDisplayTimeZone()
const { live, create } = useEventWrites()
const { loading } = useLiveStatus()
const { bookable } = useResourceRights()
const { book } = useResourceBooking()
const resourceBookings = useResourceBookings()

const SERIES_NOTE = N_(
  'This event repeats, so it is saved without booking. Open one occurrence afterwards and add the resource there.',
)

const fields = useTemplateRef('fields')
const formElement = useTemplateRef('formElement')

// Live: only the calendars the viewer may write to. Demo: all of them, as in Phase 1.
const choosableCalendars = computed(() =>
  live.value ? writableCalendars(calendars.value) : calendars.value,
)
const calendarIds = computed(() => choosableCalendars.value.map((calendar) => calendar.id))
// Not while the calendars are still being loaded: the list is empty until they arrive.
const noWritableCalendar = computed(
  () => live.value && !loading.value && choosableCalendars.value.length === 0,
)

function createForm(): EventForm {
  return initialEventForm({
    preset: quickAddPreset.value,
    anchor: anchorDate.value,
    calendars: choosableCalendars.value,
    visibleCalendarIds: visibleCalendarIds.value,
  })
}

const form = ref(createForm())
const submitted = ref(false)
const pending = ref(false)
const submitError = ref('')
const chosenResources = ref<string[]>([])
const bookNow = ref(true)
/** The event is saved but a resource was refused: the form only says so, saving again would double it. */
const saved = ref(false)
const isSeries = computed(() => form.value.repeat !== 'none')
const errors = computed(() =>
  submitted.value ? validateEventForm(form.value, calendarIds.value) : {},
)

// The dialog has no trigger element, so Reka UI cannot restore focus by itself. Remember the
// element that opened it, for example the quick-add button or a date cell.
let opener: HTMLElement | null = null
// Counts the openings: an answer that arrives after the dialog was closed must not touch the
// form of a later opening.
let session = 0

watch(quickAddOpen, (open) => {
  if (!open) return
  session += 1
  form.value = createForm()
  submitted.value = false
  pending.value = false
  submitError.value = ''
  chosenResources.value = []
  bookNow.value = true
  saved.value = false
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
})

// The calendars can arrive after the dialog opened (a slow server, or a first visit): the form was
// made without one, so the choice is made when they do, unless the person has chosen already.
watch(choosableCalendars, () => {
  if (!quickAddOpen.value || form.value.calendarId !== '') return
  form.value = { ...form.value, calendarId: createForm().calendarId }
})

function onOpenChange(open: boolean) {
  if (!open) closeQuickAdd()
}

function focusTitle(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  if (fields.value?.focusTitle()) event.preventDefault()
}

function restoreFocus(event: Event) {
  event.preventDefault()
  if (opener?.isConnected) opener.focus()
  opener = null
}

/** The toast after an event was added: where it is, and a way to it when it is out of view. */
function announceAdded(event: CalendarEvent, extra = '') {
  const calendarName = calendarById.value.get(event.calendarId)?.name ?? t('The calendar')
  if (!visibleCalendarIds.value.includes(event.calendarId)) {
    toast.add({
      title: tv(SUCCESS_TITLES.created),
      description: [
        t('{name} is hidden, so the new event is not shown.', { name: calendarName }),
        extra,
      ]
        .filter(Boolean)
        .join(' '),
      icon: 'i-lucide-check',
    })
    return
  }
  // An event outside the shown period would look as if nothing happened: offer to jump to it.
  const shown = eventOverlapsRange(event, visibleRange.value)
  toast.add({
    title: tv(SUCCESS_TITLES.created),
    description: [t('{title} in {name}.', { title: event.title, name: calendarName }), extra]
      .filter(Boolean)
      .join(' '),
    icon: 'i-lucide-check',
    actions: shown
      ? undefined
      : [
          {
            label: t('Show'),
            onClick: () => {
              anchorDate.value = Temporal.PlainDate.from(event.start.slice(0, 10))
            },
          },
        ],
  })
}

/** The event as the calendar will show it, for the toast; the real one arrives with the reload. */
function previewOf(value: EventForm): CalendarEvent {
  const range = toWallClockRange(value)
  return {
    id: '',
    uid: '',
    calendarId: value.calendarId,
    title: value.title.trim(),
    start: range.start,
    end: range.end,
    allDay: range.allDay,
    status: 'confirmed',
    categoryIds: [],
  }
}

/** Books the chosen resources of a saved event; never throws. */
async function bookChosen(
  values: EventForm,
  outcome: { uid: string; url: string },
  calendarHref: string,
): Promise<{ failures: string[]; summary: string }> {
  const chosen = bookable.value.filter((item) => chosenResources.value.includes(item.id))
  if (chosen.length === 0) return { failures: [], summary: '' }
  if (isSeries.value) return { failures: [tv(SERIES_NOTE)], summary: '' }
  if (!bookNow.value)
    return { failures: [], summary: t('Saved as a draft: nothing is booked yet.') }
  const report = await book({
    resources: chosen,
    slot: slotOf(toWallClockRange(values), timeZone.value),
    eventUid: outcome.uid,
    markUrl: outcome.url,
    calendarHref,
  })
  const failures = [...report.failures]
  if (report.result.marksFailed) {
    failures.push(t('The booking was made, but the event could not be marked with it.'))
  }
  return { failures, summary: report.booked ?? '' }
}

/** Demo mode: the bookings only exist in local state, and they wait for approval like real ones. */
function bookChosenInDemo(values: EventForm): string {
  const chosen = bookable.value.filter((item) => chosenResources.value.includes(item.id))
  if (chosen.length === 0) return ''
  if (isSeries.value) return tv(SERIES_NOTE)
  if (!bookNow.value) return t('Saved as a draft: nothing is booked yet.')
  const slot = slotOf(toWallClockRange(values), timeZone.value)
  for (const item of chosen) {
    resourceBookings.addDemoBooking({
      resourceId: item.id,
      resourceName: item.name,
      start: slot.startAt,
      end: slot.endAt,
      requesterName: 'You',
    })
  }
  return t('{names} requested, waiting for approval.', {
    names: chosen.map((item) => item.name).join(', '),
  })
}

async function submitLive() {
  const calendar = calendarById.value.get(form.value.calendarId)
  if (!calendar?.href) {
    submitError.value = t('Choose a calendar you can write to.')
    return
  }
  const values = form.value
  const mine = session
  pending.value = true
  submitError.value = ''
  try {
    const outcome = await create({
      calendarHref: calendar.href,
      input: toWriterNewEvent(values),
    })
    const stale = mine !== session || !quickAddOpen.value
    if (!outcome.ok) {
      // The form closed meanwhile: there is no form to put the message in.
      if (stale || outcome.failure.closeForm) {
        if (!stale) closeQuickAdd()
        toast.add({
          title: t('The event could not be added'),
          description: outcome.failure.message,
          icon: 'i-lucide-triangle-alert',
          color: 'error',
        })
      } else {
        submitError.value = outcome.failure.message
      }
      return
    }
    const booking = await bookChosen(values, outcome, calendar.href)
    if (booking.failures.length > 0 && !stale) {
      submitError.value = t('The event was saved. {reasons}', {
        reasons: booking.failures.join(' '),
      })
      saved.value = true
    } else if (!stale) closeQuickAdd()
    announceAdded(previewOf(values), booking.summary)
  } finally {
    if (mine === session) pending.value = false
  }
}

async function onSubmit() {
  if (pending.value) return
  submitted.value = true
  if (Object.keys(errors.value).length > 0) {
    fields.value?.revealErrors(errors.value)
    await nextTick()
    formElement.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    return
  }

  if (live.value) {
    await submitLive()
    return
  }
  const event = addEvent(toNewEventInput(form.value))
  const summary = bookChosenInDemo(form.value)
  closeQuickAdd()
  announceAdded(event, summary)
}
</script>
