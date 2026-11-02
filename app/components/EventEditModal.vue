<!--
  Edit dialog (FR-9): the form of "Quick add" filled with an existing event. The calendar is shown
  but cannot be changed (moving an event between calendars is not offered). It reports only the
  fields the person changed (`submit`), and shows `error` when saving failed; the caller does the
  writing and closes the dialog. The caller has already asked which events of a series are meant
  (`scope`), the dialog only says it.

  Focus: into the title when it opens; back to `returnFocusTo` when it closes without a save.
-->
<template>
  <UModal
    :open="open"
    :title="t('Edit event')"
    :description="scopeSummary"
    :content="{ onOpenAutoFocus: focusTitle, onCloseAutoFocus: restoreFocus }"
    @update:open="onOpenChange"
  >
    <template #body>
      <form
        id="edit-event-form"
        ref="formElement"
        novalidate
        class="flex flex-col gap-4"
        :aria-busy="pending"
        @submit.prevent="onSubmit"
      >
        <FormAlert :message="error" />
        <EventFormFields
          v-if="form"
          ref="fields"
          v-model="form"
          mode="edit"
          :errors="errors"
          extended
          details
          :calendars="calendarList"
          :calendar-name="calendar?.name ?? ''"
          :category-names="categoryNames"
          :time-zone="timeZone"
        />
        <ResourceBookingFields
          v-model="chosenResources"
          :offered="offered"
          :booked="booked"
          :note="resourceNote"
          :disabled="pending"
        />
      </form>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-end gap-2">
        <BookRightAwayCheckbox
          v-if="chosenResources.length > 0"
          v-model="bookNow"
          :disabled="pending"
          class="me-auto"
        />
        <UButton
          :label="t('Cancel')"
          color="neutral"
          variant="outline"
          @click="emit('update:open', false)"
        />
        <UButton type="submit" form="edit-event-form" :label="t('Save')" :loading="pending" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { Calendar, CalendarEvent } from '../../shared/types/calendar'
import type { BookableResource } from '~/utils/resources/types'
import type { ReadEvent } from '~/utils/ical/x-properties'
import { N_, t, tv } from '~/utils/i18n'
import { keepFocusOffControlsOnTouch, pickFocusTarget } from '~/utils/focus'
import type { EventChanges } from '~/utils/ical/write-types'
import {
  diffEventForm,
  eventFormFromEvent,
  validateEventForm,
  type EventForm,
} from '~/utils/writes/event-form'
import type { ScopeChoice } from '~/utils/writes/types'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** The event as it was when the dialog was asked for; later changes of the state do not touch the form. */
    event: CalendarEvent | null
    /** Which events of a series are edited; null for a single event. */
    scope?: ScopeChoice | null
    calendar?: Pick<Calendar, 'id' | 'name' | 'color'> | null
    /** Category names to offer. */
    categoryNames?: readonly string[]
    pending?: boolean
    /** Why the last save failed; shown at the top of the form. */
    error?: string
    returnFocusTo?: HTMLElement | false | null
  }>(),
  {
    scope: null,
    calendar: null,
    categoryNames: () => [],
    pending: false,
    error: '',
    returnFocusTo: null,
  },
)

const emit = defineEmits<{
  'update:open': [open: boolean]
  /** `booking`: the resources to book for the event, only when "Book right away" is checked. */
  submit: [changes: EventChanges, booking?: BookableResource[]]
}>()
useBackDismiss(toRef(props, 'open'), () => emit('update:open', false))

const timeZone = useDisplayTimeZone()
const { bookable } = useResourceRights()
const { resources } = useCalendarState()
const fields = useTemplateRef('fields')
const formElement = useTemplateRef('formElement')

const original = ref<EventForm | null>(null)
const form = ref<EventForm | null>(null)
const submitted = ref(false)

// Resources (FR-17). Marks cover a whole series, so a series can only get a resource through one
// occurrence ("this event"); resources the event books already are shown, not offered again.
const chosenResources = ref<string[]>([])
const bookNow = ref(true)
const marks = computed(() => (props.event as ReadEvent | null)?.bookingMarks)
const booked = computed(() => {
  const id = marks.value?.resourceId
  const resource = resources.value.find((item) => item.id === String(id))
  return resource ? [{ name: resource.name, status: marks.value?.status }] : []
})
const mayAddResources = computed(() => !props.event?.recurring || props.scope === 'this')
const offered = computed(() =>
  mayAddResources.value
    ? bookable.value.filter((item) => item.id !== String(marks.value?.resourceId))
    : [],
)
const resourceNote = computed(() =>
  !mayAddResources.value && bookable.value.length > 0
    ? t('To book a resource for a repeating event, edit one occurrence ("This event").')
    : '',
)

const calendarList = computed(() => (props.calendar ? [props.calendar] : []))
const errors = computed(() =>
  submitted.value && form.value
    ? validateEventForm(form.value, [form.value.calendarId], {
        ...(original.value ? { original: original.value } : {}),
      })
    : {},
)

const SCOPE_SUMMARIES: Record<ScopeChoice, string> = {
  this: N_('Changing this event only.'),
  following: N_('Changing this and the following events.'),
  all: N_('Changing all events of the series.'),
}
const scopeSummary = computed(() =>
  props.scope ? tv(SCOPE_SUMMARIES[props.scope]) : t('Change the details of this event.'),
)

watch(
  () => props.open,
  (open) => {
    if (!open || !props.event) return
    original.value = eventFormFromEvent(props.event)
    form.value = eventFormFromEvent(props.event)
    submitted.value = false
    chosenResources.value = []
    bookNow.value = true
  },
  { immediate: true },
)

function onOpenChange(open: boolean) {
  emit('update:open', open)
}

function focusTitle(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  if (fields.value?.focusTitle()) event.preventDefault()
}

function restoreFocus(event: Event) {
  event.preventDefault()
  if (props.returnFocusTo === false) return
  pickFocusTarget(
    props.returnFocusTo,
    document.querySelector<HTMLElement>('[data-calendar-main]'),
  )?.focus()
}

async function onSubmit() {
  if (props.pending || !form.value || !original.value) return
  submitted.value = true
  if (Object.keys(errors.value).length > 0) {
    fields.value?.revealErrors(errors.value)
    await nextTick()
    formElement.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    return
  }
  const changes = diffEventForm(original.value, form.value)
  const chosen = bookNow.value
    ? offered.value.filter((item) => chosenResources.value.includes(item.id))
    : []
  if (chosen.length > 0) emit('submit', changes, chosen)
  else emit('submit', changes)
}
</script>
