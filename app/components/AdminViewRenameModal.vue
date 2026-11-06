<!--
  Renames a view (FR-2): a shared one by default, a user's own with `shared` false. It reports the
  new name; the caller saves it and closes the dialog, or sets `error` to keep it open.
-->
<template>
  <RenameDialog
    :open="open"
    :title="shared ? t('Rename shared view') : t('Rename view')"
    :description="shared ? t('Everybody sees the new name.') : t('Only you see this view.')"
    :value="viewName"
    :pending="pending"
    :error="error"
    @update:open="emit('update:open', $event)"
    @save="emit('save', $event)"
  />
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'

withDefaults(
  defineProps<{
    open: boolean
    viewName: string
    shared?: boolean
    pending?: boolean
    error?: string
  }>(),
  { shared: true, pending: false, error: undefined },
)
const emit = defineEmits<{ 'update:open': [open: boolean]; save: [name: string] }>()
</script>
