<!--
  The fields of the event dialogs, shared by "Quick add" (create) and "Edit": title, calendar, all
  day, start and end, then, on live data, description and location, and for a new event the repeat
  rule, for an existing one the status and the categories. The parent owns the form (v-model) and
  the validation messages; the model and its rules are in app/utils/writes/event-form.ts.

  Without `extended` (the in-memory demo) only the five fields of the Phase 1 dialog are drawn.
-->
<template>
  <div class="flex flex-col gap-4">
    <UFormField label="Title" name="title" required :error="errors.title">
      <UInput
        ref="titleInput"
        :model-value="form.title"
        required
        class="w-full"
        @update:model-value="patch({ title: text($event) })"
      />
    </UFormField>

    <UFormField
      v-if="mode === 'create'"
      label="Calendar"
      name="calendarId"
      required
      :error="errors.calendarId"
    >
      <USelect
        :model-value="form.calendarId"
        :items="calendarItems"
        placeholder="Choose a calendar"
        required
        class="w-full"
        :ui="SELECT_UI"
        @update:model-value="patch({ calendarId: text($event) })"
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
    <!-- Moving an event to another calendar is not offered: the calendar is shown, not editable. -->
    <UFormField v-else label="Calendar" name="calendarId">
      <UInput :model-value="calendarName" readonly class="w-full">
        <template v-if="selectedCalendar" #leading>
          <span
            class="size-3 rounded-full"
            :style="{ backgroundColor: selectedCalendar.color }"
            aria-hidden="true"
          />
        </template>
      </UInput>
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
      :help="extended && !form.allDay ? `Times are in your time zone (${timeZone}).` : undefined"
    >
      <UInput
        :key="inputType"
        :model-value="form.end"
        :type="inputType"
        required
        class="w-full"
        @update:model-value="patch({ end: text($event) })"
      />
    </UFormField>

    <template v-if="extended && mode === 'create'">
      <UFormField
        label="Repeat"
        name="repeat"
        :help="monthlyDayWarning ? `Months without a day ${startDay} are skipped.` : undefined"
      >
        <USelect
          :model-value="form.repeat"
          :items="repeatItems"
          class="w-full"
          :ui="SELECT_UI"
          @update:model-value="patch({ repeat: $event as RepeatKind })"
        />
      </UFormField>

      <template v-if="form.repeat !== 'none'">
        <UFormField label="Ends" name="repeatEnds">
          <USelect
            :model-value="form.repeatEnds"
            :items="repeatEndsItems"
            class="w-full"
            :ui="SELECT_UI"
            @update:model-value="patch({ repeatEnds: $event as RepeatEnds })"
          />
        </UFormField>

        <UFormField
          v-if="form.repeatEnds === 'on'"
          label="Last day of the repeat"
          name="repeatUntil"
          required
          :error="errors.repeatUntil"
        >
          <UInput
            type="date"
            :model-value="form.repeatUntil"
            required
            class="w-full"
            @update:model-value="patch({ repeatUntil: text($event) })"
          />
        </UFormField>

        <UFormField
          v-if="form.repeatEnds === 'after'"
          label="Number of times"
          name="repeatCount"
          required
          :error="errors.repeatCount"
        >
          <UInput
            type="number"
            inputmode="numeric"
            min="1"
            :max="MAX_REPEAT_COUNT"
            :model-value="form.repeatCount"
            required
            class="w-full"
            @update:model-value="patch({ repeatCount: text($event) })"
          />
        </UFormField>
      </template>
    </template>

    <template v-if="extended">
      <UFormField label="Location" name="location">
        <UInput
          :model-value="form.location"
          class="w-full"
          @update:model-value="patch({ location: text($event) })"
        />
      </UFormField>

      <UFormField label="Description" name="description">
        <UTextarea
          :model-value="form.description"
          :rows="3"
          autoresize
          :maxrows="8"
          class="w-full"
          @update:model-value="patch({ description: text($event) })"
        />
      </UFormField>

      <template v-if="mode === 'edit'">
        <UFormField label="Status" name="status">
          <USelect
            :model-value="form.status"
            :items="STATUS_ITEMS"
            class="w-full"
            :ui="SELECT_UI"
            @update:model-value="patch({ status: $event as EventStatus })"
          />
        </UFormField>

        <UCheckboxGroup
          v-if="categoryOptions.length > 0"
          :model-value="form.categoryNames"
          :items="categoryOptions"
          legend="Categories"
          :ui="CHECKBOX_UI"
          @update:model-value="patch({ categoryNames: toNames($event) })"
        />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { Temporal } from 'temporal-polyfill'
import type { EventStatus } from '../../shared/types/calendar'
import { setQuickAddAllDay, setQuickAddStart } from '~/utils/quick-add'
import {
  MAX_REPEAT_COUNT,
  REPEAT_ENDS_LABELS,
  REPEAT_KINDS,
  REPEAT_LABELS,
  type EventForm,
  type EventFormErrors,
  type RepeatEnds,
  type RepeatKind,
} from '~/utils/writes/event-form'

const props = withDefaults(
  defineProps<{
    mode?: 'create' | 'edit'
    errors?: EventFormErrors
    /** Draw description, location, repeat (new) and status, categories (existing). */
    extended?: boolean
    /** The calendars a new event can go to. */
    calendars?: readonly { id: string; name: string; color: string }[]
    /** The calendar of an existing event (shown, not changeable). */
    calendarName?: string
    /** Names offered as categories; the event's own are kept even when they are not listed. */
    categoryNames?: readonly string[]
    /** The viewer's display zone, named in the help text of the times. */
    timeZone?: string
  }>(),
  {
    mode: 'create',
    errors: () => ({}),
    extended: false,
    calendars: () => [],
    calendarName: '',
    categoryNames: () => [],
    timeZone: '',
  },
)

const form = defineModel<EventForm>({ required: true })
const titleInput = useTemplateRef('titleInput')

const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }
// A row is a 44 px target in full: the checkbox's pseudo-element spreads over the whole row.
const CHECKBOX_UI = {
  item: 'min-h-11 items-center',
  base: 'before:absolute before:inset-0',
  fieldset: 'gap-1',
}
const STATUS_ITEMS = [
  { label: 'Confirmed', value: 'confirmed' },
  { label: 'Tentative', value: 'tentative' },
  { label: 'Cancelled', value: 'cancelled' },
]
const repeatItems = REPEAT_KINDS.map((kind) => ({ label: REPEAT_LABELS[kind], value: kind }))
const repeatEndsItems = (Object.keys(REPEAT_ENDS_LABELS) as RepeatEnds[]).map((kind) => ({
  label: REPEAT_ENDS_LABELS[kind],
  value: kind,
}))

const calendarItems = computed(() =>
  props.calendars.map((calendar) => ({
    label: calendar.name,
    value: calendar.id,
    color: calendar.color,
  })),
)
const selectedCalendar = computed(() =>
  props.calendars.find((calendar) => calendar.id === form.value.calendarId),
)
const inputType = computed(() => (form.value.allDay ? 'date' : 'datetime-local'))

// Offered categories: the known ones plus those the event carries that the list does not know.
const categoryOptions = computed(() => {
  const names = [...props.categoryNames]
  for (const name of form.value.categoryNames) if (!names.includes(name)) names.push(name)
  return names
})

// A monthly repeat on the 29th to the 31st skips the shorter months (RFC 5545).
const startDay = computed(() => {
  try {
    return Temporal.PlainDate.from(form.value.start.slice(0, 10)).day
  } catch {
    return 1
  }
})
const monthlyDayWarning = computed(() => form.value.repeat === 'monthly' && startDay.value > 28)

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function toNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

// A model that the parent owns only shows a change after the parent has rendered again. Two
// edits in one tick (autofill, a fast paste) would both start from the old form and the second
// would undo the first, so every edit builds on the last one made here.
let latest = form.value
watch(form, (value) => (latest = value), { flush: 'sync' })

function update(next: EventForm) {
  latest = next
  form.value = next
}

function patch(change: Partial<EventForm>) {
  update({ ...latest, ...change })
}

function onAllDayChange(allDay: boolean) {
  update(setQuickAddAllDay(latest, allDay))
}

function onStartChange(start: string | number | null | undefined) {
  update(setQuickAddStart(latest, text(start)))
}

defineExpose({
  /** Puts the cursor into the title (where a dialog starts). */
  focusTitle(): boolean {
    const input = titleInput.value?.inputRef
    if (!input) return false
    input.focus()
    return true
  },
})
</script>
