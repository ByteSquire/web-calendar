<!--
  The resources of an event dialog (FR-17): the chosen ones with a button to remove each, and a
  select to add one. Choosing a resource books nothing by itself; the dialog books when the event
  is saved and "Book right away" is checked (BookRightAwayCheckbox beside the save button).
  `booked` lists resources the event already books, read-only (cancel them in "Resource bookings").
-->
<template>
  <fieldset
    v-if="offered.length > 0 || booked.length > 0 || modelValue.length > 0 || note"
    class="flex flex-col gap-2"
  >
    <legend class="text-sm font-medium">Resources</legend>

    <ul v-if="booked.length > 0" class="flex flex-col gap-1" data-booked-resources>
      <li v-for="item in booked" :key="item.name" class="flex min-h-11 items-center gap-2 text-sm">
        <UIcon name="i-lucide-door-open" class="size-4 shrink-0" aria-hidden="true" />
        <span
          >{{ item.name
          }}<span v-if="item.status" class="text-toned"> ({{ item.status }})</span></span
        >
      </li>
    </ul>

    <ul v-if="chosen.length > 0" class="flex flex-col gap-1" data-chosen-resources>
      <li
        v-for="item in chosen"
        :key="item.id"
        class="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-default ps-3"
      >
        <span class="flex items-center gap-2">
          <UIcon name="i-lucide-door-open" class="size-4 shrink-0" aria-hidden="true" />
          {{ item.name }}
        </span>
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          class="size-11 justify-center"
          :aria-label="`Remove ${item.name}`"
          :disabled="disabled"
          @click="remove(item.id)"
        />
      </li>
    </ul>

    <USelect
      v-if="available.length > 0"
      :model-value="undefined"
      :items="available"
      placeholder="Add a resource"
      aria-label="Add a resource"
      class="w-full"
      :disabled="disabled"
      :ui="{ base: 'min-h-11', item: 'min-h-11 items-center' }"
      @update:model-value="add(String($event))"
    />

    <p v-if="note" data-resource-note class="text-sm text-toned">{{ note }}</p>
  </fieldset>
</template>

<script setup lang="ts">
import type { BookableResource } from '~/utils/resources/types'

const props = withDefaults(
  defineProps<{
    /** The resources the viewer may book. */
    offered: readonly BookableResource[]
    /** Ids of the resources chosen so far. */
    modelValue: readonly string[]
    /** Resources the event already books (shown, not changeable here). */
    booked?: readonly { name: string; status?: string }[]
    /** Why booking works differently for this event (a series). */
    note?: string
    disabled?: boolean
  }>(),
  { booked: () => [], note: '', disabled: false },
)

const emit = defineEmits<{ 'update:modelValue': [ids: string[]] }>()

const chosen = computed(() =>
  props.modelValue.flatMap((id) => props.offered.find((item) => item.id === id) ?? []),
)
const available = computed(() =>
  props.offered
    .filter((item) => !props.modelValue.includes(item.id))
    .map((item) => ({ label: item.name, value: item.id })),
)

function add(id: string) {
  if (!props.modelValue.includes(id)) emit('update:modelValue', [...props.modelValue, id])
}

function remove(id: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter((item) => item !== id),
  )
}
</script>
