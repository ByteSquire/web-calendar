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
    title="Edit event"
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
          :calendars="calendarList"
          :calendar-name="calendar?.name ?? ''"
          :category-names="categoryNames"
          :time-zone="timeZone"
        />
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          label="Cancel"
          color="neutral"
          variant="outline"
          @click="emit('update:open', false)"
        />
        <UButton type="submit" form="edit-event-form" label="Save" :loading="pending" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { Calendar, CalendarEvent } from '../../shared/types/calendar'
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
  submit: [changes: EventChanges]
}>()
useBackDismiss(toRef(props, 'open'), () => emit('update:open', false))

const timeZone = useDisplayTimeZone()
const fields = useTemplateRef('fields')
const formElement = useTemplateRef('formElement')

const original = ref<EventForm | null>(null)
const form = ref<EventForm | null>(null)
const submitted = ref(false)

const calendarList = computed(() => (props.calendar ? [props.calendar] : []))
const errors = computed(() =>
  submitted.value && form.value
    ? validateEventForm(form.value, [form.value.calendarId], {
        ...(original.value ? { original: original.value } : {}),
      })
    : {},
)

const SCOPE_SUMMARIES: Record<ScopeChoice, string> = {
  this: 'Changing this event only.',
  following: 'Changing this and the following events.',
  all: 'Changing all events of the series.',
}
const scopeSummary = computed(() =>
  props.scope ? SCOPE_SUMMARIES[props.scope] : 'Change the details of this event.',
)

watch(
  () => props.open,
  (open) => {
    if (!open || !props.event) return
    original.value = eventFormFromEvent(props.event)
    form.value = eventFormFromEvent(props.event)
    submitted.value = false
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
    await nextTick()
    formElement.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    return
  }
  emit('submit', diffEventForm(original.value, form.value))
}
</script>
