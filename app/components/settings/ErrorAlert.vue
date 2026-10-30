<!--
  A problem with the settings, in words, with an optional Retry. `role="alert"` makes assistive
  technology read it when it appears. Colours: see utils/settings/ui.ts.
-->
<template>
  <UAlert
    role="alert"
    color="error"
    variant="outline"
    icon="i-lucide-circle-alert"
    :title="title"
    :description="message"
    :ui="ERROR_ALERT_UI"
    :actions="retryable ? [{ label: 'Retry', color: 'neutral', variant: 'outline', onClick }] : []"
  />
</template>

<script setup lang="ts">
import { ERROR_ALERT_UI } from '~/utils/settings/ui'

defineProps<{
  message: string
  title?: string
  /** Show a Retry button; the parent listens to `retry`. */
  retryable?: boolean
}>()
const emit = defineEmits<{ retry: [] }>()

function onClick() {
  emit('retry')
}
</script>
