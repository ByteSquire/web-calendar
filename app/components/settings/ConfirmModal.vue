<!--
  A confirmation before something is removed (revoking a token, deleting a subscription). The
  dialog has no trigger element, so Reka UI cannot return focus by itself: it remembers what had
  focus when it opened and goes back there, or to `fallback` when that element is gone (the row
  was just removed). Focus starts on Cancel, the safe choice. The parent keeps the dialog open
  while `error` is set so the person can retry or cancel.
-->
<template>
  <UModal
    :open="open"
    :title="title"
    :description="description"
    :content="{ onOpenAutoFocus: focusCancel, onCloseAutoFocus: focusReturn.restore }"
    :ui="{ title: 'wrap-anywhere', description: 'wrap-anywhere' }"
    @update:open="onOpenChange"
  >
    <template #body>
      <SettingsErrorAlert v-if="error" :message="error" />
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          ref="cancelButton"
          :label="t('Cancel')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="onOpenChange(false)"
        />
        <UButton
          :label="busy ? t('Working…') : confirmLabel"
          icon="i-lucide-trash-2"
          color="neutral"
          :aria-busy="busy"
          @click="onConfirm"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { createFocusReturn } from '~/utils/settings/focus-return'

const props = defineProps<{
  open: boolean
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  /** Why the last attempt failed; shown inside the dialog. */
  error: string | null
  /** Where focus goes when the element that opened the dialog is gone. */
  fallback?: HTMLElement | null
}>()
const emit = defineEmits<{ 'update:open': [value: boolean]; confirm: [] }>()

const cancelButton = useTemplateRef<{ $el: HTMLElement }>('cancelButton')
const focusReturn = createFocusReturn(() => props.fallback)

watch(
  () => props.open,
  (open) => {
    if (open) focusReturn.remember()
  },
)

function onOpenChange(open: boolean) {
  // A request in flight cannot be taken back: stay open until it has answered.
  if (!open && props.busy) return
  emit('update:open', open)
}

function onConfirm() {
  // Not `disabled` while busy: a button that disables itself drops the keyboard focus.
  if (!props.busy) emit('confirm')
}

function focusCancel(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  cancelButton.value?.$el.focus()
}
</script>
