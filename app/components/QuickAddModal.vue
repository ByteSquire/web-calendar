<!--
  Quick-add dialog (FR-24). The layout always mounts it; it is open while `quickAddOpen` is set in
  useCalendarState(). Each time it opens, the form starts from `quickAddPreset` (or from the anchor
  date, 09:00 to 10:00) and validates on submit; after a failed submit the messages follow the
  input live. Form model, defaults and validation: app/utils/quick-add.ts.
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
        @submit.prevent="onSubmit"
      >
        <UFormField label="Title" name="title" required :error="errors.title">
          <UInput ref="titleInput" v-model="form.title" required class="w-full" />
        </UFormField>

        <UFormField label="Calendar" name="calendarId" required :error="errors.calendarId">
          <USelect
            v-model="form.calendarId"
            :items="calendarItems"
            placeholder="Choose a calendar"
            required
            class="w-full"
            :ui="{ base: 'min-h-11', item: 'min-h-11 items-center' }"
          >
            <template #leading>
              <span
                v-if="selectedCalendar"
                class="size-3 rounded-full"
                :style="{ backgroundColor: selectedCalendar.color }"
                aria-hidden="true"
              />
            </template>
            <template #item-leading="{ item }">
              <span
                class="size-3 shrink-0 rounded-full"
                :style="{ backgroundColor: item.color }"
                aria-hidden="true"
              />
            </template>
          </USelect>
        </UFormField>

        <USwitch
          :model-value="form.allDay"
          label="All day"
          class="min-h-11 items-center"
          :ui="{
            // The switch is small; the pseudo-element grows its hit area to 44 px.
            base: 'relative before:absolute before:-inset-x-2 before:-inset-y-3',
            label: 'flex min-h-11 cursor-pointer items-center',
          }"
          @update:model-value="onAllDayChange"
        />

        <!-- Keyed by the input type: the browser drops a value that does not fit a new type. -->
        <UFormField
          :label="form.allDay ? 'Start date' : 'Start'"
          name="start"
          required
          :error="errors.start"
        >
          <UInput
            :key="inputType"
            :type="inputType"
            :model-value="form.start"
            required
            class="w-full"
            @update:model-value="onStartChange"
          />
        </UFormField>

        <UFormField
          :label="form.allDay ? 'End date' : 'End'"
          name="end"
          required
          :error="errors.end"
        >
          <UInput :key="inputType" v-model="form.end" :type="inputType" required class="w-full" />
        </UFormField>
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="outline" @click="closeQuickAdd()" />
        <UButton type="submit" form="quick-add-form" label="Add event" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { Temporal } from 'temporal-polyfill'
import { eventOverlapsRange } from '~/utils/calendar-state'
import {
  initialQuickAddForm,
  setQuickAddAllDay,
  setQuickAddStart,
  toNewEventInput,
  validateQuickAdd,
  type QuickAddForm,
} from '~/utils/quick-add'

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
const toast = useToast()

const titleInput = useTemplateRef('titleInput')
const formElement = useTemplateRef('formElement')

// All calendars for now; Phase 3 narrows this to the ones the user may write to.
const calendarIds = computed(() => calendars.value.map((calendar) => calendar.id))
const calendarItems = computed(() =>
  calendars.value.map((calendar) => ({
    label: calendar.name,
    value: calendar.id,
    color: calendar.color,
  })),
)

function createForm(): QuickAddForm {
  return initialQuickAddForm({
    preset: quickAddPreset.value,
    anchor: anchorDate.value,
    calendars: calendars.value,
    visibleCalendarIds: visibleCalendarIds.value,
  })
}

const form = ref(createForm())
const submitted = ref(false)
const errors = computed(() =>
  submitted.value ? validateQuickAdd(form.value, calendarIds.value) : {},
)
const selectedCalendar = computed(() => calendarById.value.get(form.value.calendarId))
const inputType = computed(() => (form.value.allDay ? 'date' : 'datetime-local'))

// The dialog has no trigger element, so Reka UI cannot restore focus by itself. Remember the
// element that opened it, for example the quick-add button or a date cell.
let opener: HTMLElement | null = null

watch(quickAddOpen, (open) => {
  if (!open) return
  form.value = createForm()
  submitted.value = false
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
})

function onOpenChange(open: boolean) {
  if (!open) closeQuickAdd()
}

function focusTitle(event: Event) {
  const input = titleInput.value?.inputRef
  if (!input) return
  event.preventDefault()
  input.focus()
}

function restoreFocus(event: Event) {
  event.preventDefault()
  if (opener?.isConnected) opener.focus()
  opener = null
}

function onAllDayChange(allDay: boolean) {
  form.value = setQuickAddAllDay(form.value, allDay)
}

function onStartChange(start: string | number | null | undefined) {
  form.value = setQuickAddStart(form.value, String(start ?? ''))
}

async function onSubmit() {
  submitted.value = true
  if (Object.keys(errors.value).length > 0) {
    await nextTick()
    formElement.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    return
  }

  const event = addEvent(toNewEventInput(form.value))
  closeQuickAdd()

  const calendarName = calendarById.value.get(event.calendarId)?.name ?? 'The calendar'
  if (!visibleCalendarIds.value.includes(event.calendarId)) {
    toast.add({
      title: 'Event added',
      description: `${calendarName} is hidden, so the new event is not shown.`,
      icon: 'i-lucide-check',
    })
    return
  }
  // An event outside the shown period would look as if nothing happened: offer to jump to it.
  const shown = eventOverlapsRange(event, visibleRange.value)
  toast.add({
    title: 'Event added',
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
</script>
