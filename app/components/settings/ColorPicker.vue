<!--
  Colour of a calendar (a subscription, an account's calendars, a group calendar, a calendar in the
  sidebar): a radio group over a small palette, and "Custom" for any colour. Native radios (hidden,
  but focusable) give the group role, the arrow keys and the name; each choice shows its colour name
  as text and the selected one a check mark and a ring, so the choice never depends on colour alone
  (WCAG 1.4.1). "Custom" opens the browser's own colour picker and a field for the colour code
  (#rrggbb), which is also how a colour is chosen without seeing it. Every choice is at least 44 px
  tall (design §9). Event text on any colour is black or white, whichever reads (readableTextColor).
-->
<template>
  <fieldset class="min-w-0">
    <legend class="mb-1 text-sm font-medium text-default">{{ t('Colour') }}</legend>
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
          :checked="!isCustom && modelValue === choice.value"
          @change="emit('update:modelValue', choice.value)"
        />
        <span
          class="flex size-6 items-center justify-center rounded-full ring-1 ring-black/40 dark:ring-white/60"
          :class="
            choice.value === '' && !choice.swatch
              ? 'border border-dashed border-accented bg-default'
              : ''
          "
          :style="
            choice.value || choice.swatch
              ? { backgroundColor: choice.value || choice.swatch }
              : undefined
          "
          aria-hidden="true"
        >
          <UIcon
            v-if="!isCustom && modelValue === choice.value"
            name="i-lucide-check"
            class="size-4"
            :class="
              choice.value === '' && !choice.swatch
                ? 'text-default'
                : checkClass(choice.value || choice.swatch!)
            "
          />
        </span>
        <span>{{ tv(choice.name) }}</span>
      </label>
      <label
        class="relative flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-center text-sm has-checked:bg-elevated has-checked:font-medium has-checked:ring-2 has-checked:ring-primary has-checked:ring-inset has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary"
      >
        <input
          type="radio"
          class="sr-only"
          :name="groupName"
          value="custom"
          :checked="isCustom"
          @change="chooseCustom"
        />
        <span
          class="flex size-6 items-center justify-center rounded-full ring-1 ring-black/40 dark:ring-white/60"
          :style="
            isCustom
              ? { backgroundColor: modelValue }
              : {
                  backgroundImage:
                    'conic-gradient(#b91c1c, #b45309, #4d7c0f, #0f766e, #1d4ed8, #6d28d9, #9d174d, #b91c1c)',
                }
          "
          aria-hidden="true"
        >
          <UIcon
            v-if="isCustom"
            name="i-lucide-check"
            class="size-4"
            :class="checkClass(modelValue)"
          />
        </span>
        <span>{{ t('Custom') }}</span>
      </label>
    </div>

    <div v-if="isCustom" class="mt-2 flex flex-wrap items-end gap-2">
      <input
        :id="`${groupName}-picker`"
        type="color"
        class="h-11 w-14 shrink-0 cursor-pointer rounded-md border border-default bg-default p-1"
        :value="modelValue"
        :aria-label="t('Custom colour')"
        @input="pick(($event.target as HTMLInputElement).value)"
      />
      <UFormField
        :label="t('Colour code')"
        :name="`${groupName}-code`"
        :error="codeError"
        :ui="FIELD_UI"
        class="min-w-0 flex-1 basis-40"
      >
        <UInput
          :model-value="code"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          class="w-full"
          :ui="{ base: 'font-mono' }"
          @update:model-value="typeCode(String($event))"
        />
      </UFormField>
    </div>
  </fieldset>
</template>

<script setup lang="ts">
import { readableTextColor } from '~/utils/fullcalendar'
import { t, tv } from '~/utils/i18n'
import type { ColorChoice } from '~/utils/settings/palette'
import { FIELD_UI } from '~/utils/settings/ui'

const props = defineProps<{
  modelValue: string
  choices: ColorChoice[]
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

// One group name per picker: native radios of the same name are one group.
const groupName = `color-${useId()}`

const HEX = /^#[0-9a-f]{6}$/
/** The colour of "Custom" when it is chosen first: a calm blue grey, easy to start from. */
const START_CUSTOM = '#475569'

const isCustom = computed(
  () =>
    props.modelValue !== '' && !props.choices.some((choice) => choice.value === props.modelValue),
)

// The code field shows what was typed, also while it is not a colour yet.
const code = ref(props.modelValue)
const codeError = ref<string | undefined>(undefined)
watch(
  () => props.modelValue,
  (value) => {
    if (value !== code.value.trim().toLowerCase()) code.value = value
    codeError.value = undefined
  },
)

function pick(value: string) {
  const next = value.toLowerCase()
  if (HEX.test(next)) emit('update:modelValue', next)
}

function chooseCustom() {
  pick(isCustom.value ? props.modelValue : START_CUSTOM)
}

function typeCode(text: string) {
  code.value = text
  const value = text.trim().toLowerCase()
  const withHash = value.startsWith('#') ? value : `#${value}`
  if (HEX.test(withHash)) {
    codeError.value = undefined
    emit('update:modelValue', withHash)
  } else {
    codeError.value = t('Enter a colour code like #1d4ed8.')
  }
}

/** The check mark in the colour's own readable text colour (black on light, white on dark). */
function checkClass(color: string): string {
  return readableTextColor(color) === '#000000' ? 'text-black' : 'text-white'
}
</script>
