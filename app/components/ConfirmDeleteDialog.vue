<!--
  "Delete 'Title'?" (FR-9): a destructive confirmation. It reports the decision and shows the
  reason a delete failed; the caller does the deleting. Focus starts on Cancel, the safe answer,
  and goes back to `returnFocusTo` when the dialog closes.
-->
<template>
  <UModal
    :open="open"
    :title="title"
    :description="detail"
    :content="{ onOpenAutoFocus: focusCancel, onCloseAutoFocus: restoreFocus }"
    @update:open="onOpenChange"
  >
    <template #body>
      <div :aria-busy="pending">
        <FormAlert :message="error" />
        <p v-if="!error" class="text-sm text-muted">This cannot be undone.</p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          ref="cancelButton"
          label="Cancel"
          color="neutral"
          variant="outline"
          @click="emit('update:open', false)"
        />
        <UButton
          label="Delete"
          color="error"
          icon="i-lucide-trash-2"
          :loading="pending"
          @click="emit('confirm')"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { pickFocusTarget } from '~/utils/focus'

const props = withDefaults(
  defineProps<{
    open: boolean
    eventTitle: string
    /** What the delete covers, for example "Only this event is deleted." */
    detail?: string
    pending?: boolean
    /** Why the last attempt failed; shown above the buttons. */
    error?: string
    returnFocusTo?: HTMLElement | false | null
  }>(),
  { detail: '', pending: false, error: '', returnFocusTo: null },
)

const emit = defineEmits<{
  'update:open': [open: boolean]
  confirm: []
}>()

const title = computed(() => `Delete "${props.eventTitle}"?`)
const cancelButton = useTemplateRef<{ $el: HTMLElement }>('cancelButton')

function onOpenChange(open: boolean) {
  emit('update:open', open)
}

function focusCancel(event: Event) {
  const button = cancelButton.value?.$el
  if (!button) return
  event.preventDefault()
  button.focus()
}

function restoreFocus(event: Event) {
  event.preventDefault()
  if (props.returnFocusTo === false) return
  pickFocusTarget(
    props.returnFocusTo,
    document.querySelector<HTMLElement>('[data-calendar-main]'),
  )?.focus()
}
</script>
