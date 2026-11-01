<template>
  <form class="flex items-start gap-2 px-2 pt-1" @submit.prevent="onSubmit">
    <UFormField
      :label="`New ${noun} name`"
      :error="error"
      :ui="{ label: 'sr-only' }"
      class="flex-1"
    >
      <UInput v-model="value" :placeholder="`Add ${noun}`" autocomplete="off" class="w-full" />
    </UFormField>
    <UButton
      type="submit"
      icon="i-lucide-plus"
      color="neutral"
      variant="subtle"
      :aria-label="`Add ${noun}`"
    />
  </form>
</template>

<script setup lang="ts">
const props = defineProps<{
  /** What is added, in lower case: names the input and the button for assistive technology. */
  noun: string
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
