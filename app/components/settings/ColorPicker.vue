<!--
  Colour of a subscription: a radio group over a small palette. Native radios (hidden, but
  focusable) give the group role, the arrow keys and the name; each choice shows its colour name
  as text and the selected one a check mark and a ring, so the choice never depends on colour
  alone (WCAG 1.4.1). Every choice is at least 44 px tall (design §9).
-->
<template>
  <fieldset class="min-w-0">
    <legend class="mb-1 text-sm font-medium text-default">Colour</legend>
    <div class="grid grid-cols-4 gap-1">
      <label
        v-for="choice in choices"
        :key="choice.value"
        class="relative flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-center text-sm has-checked:bg-elevated has-checked:font-medium has-checked:ring-2 has-checked:ring-primary has-checked:ring-inset has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary"
      >
        <input
          type="radio"
          class="sr-only"
          :name="groupName"
          :value="choice.value"
          :checked="modelValue === choice.value"
          @change="emit('update:modelValue', choice.value)"
        />
        <span
          class="flex size-6 items-center justify-center rounded-full ring-1 ring-black/40 dark:ring-white/60"
          :class="choice.value === '' ? 'border border-dashed border-accented bg-default' : ''"
          :style="choice.value ? { backgroundColor: choice.value } : undefined"
          aria-hidden="true"
        >
          <UIcon
            v-if="modelValue === choice.value"
            name="i-lucide-check"
            class="size-4"
            :class="choice.value === '' ? 'text-default' : 'text-white'"
          />
        </span>
        <span>{{ choice.name }}</span>
      </label>
    </div>
  </fieldset>
</template>

<script setup lang="ts">
import type { ColorChoice } from '~/utils/settings/palette'

defineProps<{
  modelValue: string
  choices: ColorChoice[]
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

// One group name per picker: native radios of the same name are one group.
const groupName = `color-${useId()}`
</script>
