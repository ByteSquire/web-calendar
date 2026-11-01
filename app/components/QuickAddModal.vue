<!--
  Quick-add dialog (FR-24, FR-9). The layout always mounts it; it is open while `quickAddOpen` is
  set in useCalendarState(). Each time it opens, the form starts from `quickAddPreset` (or from the
  anchor date, 09:00 to 10:00) and validates on submit; after a failed submit the messages follow
  the input live. Form model, defaults and validation: app/utils/quick-add.ts and
  app/utils/writes/event-form.ts.

  On live data the event is written to a writable calendar of the calendar service (with
  description, location and a repeat rule); the dialog stays open with the reason when that
  fails. In demo mode it is added to the in-memory store, as in Phase 1.
-->
<template>
  <UModal
    :open="quickAddOpen"
    title="Quick add"
    description="Create an event"
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
        @submit.prevent="onSubmit"
      >
        <FormAlert :message="submitError" />
        <p
          v-if="noWritableCalendar"
          class="rounded-lg border border-default bg-elevated p-3 text-sm"
        >
          None of your calendars can take new events. Ask for a calendar you can write to.
        </p>

        <EventFormFields
          ref="fields"
          v-model="form"
          mode="create"
          :errors="errors"
          :extended="live"
          :calendars="choosableCalendars"
          :time-zone="timeZone"
        />
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="outline" @click="closeQuickAdd()" />
        <UButton
          type="submit"
          form="quick-add-form"
          label="Add event"
          :loading="pending"
          :disabled="noWritableCalendar"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
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
import { SUCCESS_TITLES } from '~/utils/writes/messages'
import { writableCalendars } from '~/utils/writes/rules'

const {
  quickAddOpen,
  quickAddPreset,
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
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
function announceAdded(event: CalendarEvent) {
  const calendarName = calendarById.value.get(event.calendarId)?.name ?? 'The calendar'
  if (!visibleCalendarIds.value.includes(event.calendarId)) {
    toast.add({
      title: SUCCESS_TITLES.created,
      description: `${calendarName} is hidden, so the new event is not shown.`,
      icon: 'i-lucide-check',
    })
    return
  }
  // An event outside the shown period would look as if nothing happened: offer to jump to it.
  const shown = eventOverlapsRange(event, visibleRange.value)
  toast.add({
    title: SUCCESS_TITLES.created,
    description: `${event.title} in ${calendarName}`,
    icon: 'i-lucide-check',
    actions: shown
      ? undefined
      : [
          {
            label: 'Show',
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

async function submitLive() {
  const calendar = calendarById.value.get(form.value.calendarId)
  if (!calendar?.href) {
    submitError.value = 'Choose a calendar you can write to.'
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
          title: 'The event could not be added',
          description: outcome.failure.message,
          icon: 'i-lucide-triangle-alert',
          color: 'error',
        })
      } else {
        submitError.value = outcome.failure.message
      }
      return
    }
    if (!stale) closeQuickAdd()
    announceAdded(previewOf(values))
  } finally {
    if (mine === session) pending.value = false
  }
}

async function onSubmit() {
  if (pending.value) return
  submitted.value = true
  if (Object.keys(errors.value).length > 0) {
    await nextTick()
    formElement.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    return
  }

  if (live.value) {
    await submitLive()
    return
  }
  const event = addEvent(toNewEventInput(form.value))
  closeQuickAdd()
  announceAdded(event)
}
</script>
