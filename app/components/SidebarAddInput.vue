<template>
  <form class="flex items-start gap-2 px-2 pt-1" @submit.prevent="onSubmit">
    <UFormField
      :label="tv(NOUN_TEXTS[noun].label)"
      :error="error"
      :ui="{ label: 'sr-only' }"
      class="flex-1"
    >
      <UInput
        v-model="value"
        :placeholder="tv(NOUN_TEXTS[noun].add)"
        autocomplete="off"
        class="w-full"
      />
    </UFormField>
    <UButton
      type="submit"
      icon="i-lucide-plus"
      color="neutral"
      variant="subtle"
      :aria-label="tv(NOUN_TEXTS[noun].add)"
    />
  </form>
</template>

<script setup lang="ts">
import { N_, tv } from '~/utils/i18n'

// The texts of each kind, whole, so that a translation can put the word where it belongs.
const NOUN_TEXTS = {
  view: { label: N_('New view name'), add: N_('Add view') },
  category: { label: N_('New category name'), add: N_('Add category') },
  filter: { label: N_('New filter name'), add: N_('Add filter') },
}

const props = defineProps<{
  /** What is added: names the input and the button for assistive technology. */
  noun: 'view' | 'category' | 'filter'
  /** Receives the trimmed text. Returns an error message, or nothing when it was accepted. */
  submit: (value: string) => string | undefined | Promise<string | undefined>
}>()

const value = ref('')
const error = ref<string>()

watch(value, () => {
  error.value = undefined
})

async function onSubmit() {
  const text = value.value.trim()
  if (!text) return
  error.value = await props.submit(text)
  if (!error.value) value.value = ''
}
</script>
