<template>
  <USwitch
    v-model="checked"
    class="min-h-11 w-full flex-row-reverse items-center justify-between gap-2 rounded-md px-2 hover:bg-elevated"
    :ui="ui"
  >
    <template #label>
      <span class="flex min-w-0 items-center gap-2">
        <UIcon
          v-if="icon"
          :name="icon"
          class="size-4 shrink-0"
          :style="{ color }"
          aria-hidden="true"
        />
        <span
          v-else-if="color"
          class="size-3 shrink-0 rounded-full"
          :style="{ backgroundColor: color }"
          aria-hidden="true"
        />
        <span class="truncate">{{ label }}</span>
      </span>
    </template>
  </USwitch>
</template>

<script setup lang="ts">
defineProps<{
  label: string
  /** CSS colour of the leading dot, or of the icon when `icon` is set. Decorative. */
  color?: string
  icon?: string
}>()

const checked = defineModel<boolean>({ required: true })

const ui = {
  // The switch itself is small; the pseudo-element grows its hit area to 44 px.
  base: 'relative before:absolute before:-inset-x-2 before:-inset-y-3',
  wrapper: 'ms-0 min-w-0 flex-1',
  label: 'flex min-h-11 cursor-pointer items-center',
}
</script>
