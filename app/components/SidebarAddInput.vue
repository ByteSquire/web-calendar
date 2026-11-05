<!--
  The field that adds a view, calendar, category or filter by name. SidebarSection shows it under
  the heading (large screens) or in a pop-up (small ones, where the on-screen keyboard would
  cover a field low on the page). Enter adds; a refusal (a name that is taken, a failed request)
  keeps the field open with the message; success closes it (`added`), and so does Escape or the
  pop-up's Cancel (`cancel`). `popup` shows the label and the buttons in words.
-->
<template>
  <form
    :class="popup ? 'flex flex-col gap-4' : 'flex items-start gap-2 px-2 pt-1 pb-1'"
    @submit.prevent="onSubmit"
    @keydown.esc="onEscape"
  >
    <UFormField
      :label="tv(ADD_TEXTS[noun].label)"
      :error="error"
      :ui="popup ? {} : { label: 'sr-only' }"
      class="flex-1"
    >
      <UInput
        ref="field"
        v-model="value"
        :placeholder="popup ? undefined : tv(ADD_TEXTS[noun].add)"
        autocomplete="off"
        enterkeyhint="done"
        :readonly="busy"
        class="w-full"
      />
    </UFormField>
    <div v-if="popup" class="flex justify-end gap-2">
      <UButton
        type="button"
        :label="t('Cancel')"
        color="neutral"
        variant="outline"
        @click="emit('cancel')"
      />
      <UButton type="submit" :label="t('Add')" :loading="busy" />
    </div>
    <UButton
      v-else
      type="submit"
      icon="i-lucide-check"
      color="neutral"
      variant="subtle"
      :loading="busy"
      :aria-label="t('Add')"
    />
  </form>
</template>

<script setup lang="ts">
import { t, tv } from '~/utils/i18n'
import { ADD_TEXTS, type AddNoun } from '~/utils/sidebar-sections'

const props = defineProps<{
  /** What is added: names the field for assistive technology. */
  noun: AddNoun
  /** Receives the trimmed text. Returns an error message, or nothing when it was accepted. */
  submit: (value: string) => string | undefined | Promise<string | undefined>
  /** Shown in a pop-up: the label is visible and the buttons have words. */
  popup?: boolean
}>()
const emit = defineEmits<{ added: []; cancel: [] }>()

const field = useTemplateRef<{ inputRef: HTMLInputElement | null }>('field')
const value = ref('')
const error = ref<string>()
// A submit that takes time (a request) cannot be sent twice: the button waits and the field is
// read-only (not disabled, so that the keyboard focus stays in it).
const busy = ref(false)

watch(value, () => {
  error.value = undefined
})

function focus() {
  field.value?.inputRef?.focus()
}
defineExpose({ focus })

// The field was opened to type in, so it takes the focus. In the pop-up the dialog hands it over
// once it is open (SidebarSection), which is later than this component is mounted.
onMounted(() => {
  if (!props.popup) focus()
})

function onEscape(event: KeyboardEvent) {
  // In the pop-up the dialog closes itself on Escape.
  if (props.popup) return
  event.stopPropagation()
  emit('cancel')
}

async function onSubmit() {
  const text = value.value.trim()
  if (!text || busy.value) return
  busy.value = true
  try {
    error.value = await props.submit(text)
  } finally {
    busy.value = false
  }
  if (error.value) return
  value.value = ''
  emit('added')
}
</script>
