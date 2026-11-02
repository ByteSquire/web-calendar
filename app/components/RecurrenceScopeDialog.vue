<!--
  "Which events?" for a change to a repeating event (FR-9): this event (the default), this and
  following events, or all events. Used before editing and before deleting. A plain dialog: it
  reports the choice and does nothing else. The default is chosen again each time it opens, so a
  quick Enter never applies the broadest change by habit.

  Focus: into the chosen radio when it opens. On Cancel / Escape it goes back to `returnFocusTo`;
  after a choice it stays with whatever the caller opens next.
-->
<template>
  <UModal
    :open="open"
    :title="action === 'delete' ? t('Delete repeating event') : t('Edit repeating event')"
    :description="eventTitle"
    :content="{ onOpenAutoFocus: focusChoice, onCloseAutoFocus: restoreFocus }"
    @update:open="onOpenChange"
  >
    <template #body>
      <form id="recurrence-scope-form" @submit.prevent="onContinue">
        <URadioGroup
          v-model="choice"
          :items="items"
          :legend="action === 'delete' ? t('Delete which events?') : t('Change which events?')"
          :ui="RADIO_UI"
        />
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('Cancel')"
          color="neutral"
          variant="outline"
          @click="emit('update:open', false)"
        />
        <UButton type="submit" form="recurrence-scope-form" :label="t('Continue')" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { t, tv } from '~/utils/i18n'
import { keepFocusOffControlsOnTouch, pickFocusTarget } from '~/utils/focus'
import { SCOPE_CHOICES, SCOPE_LABELS, type ScopeChoice } from '~/utils/writes/types'

const props = withDefaults(
  defineProps<{
    open: boolean
    action?: 'edit' | 'delete'
    /** The event's title, shown under the dialog title. */
    eventTitle?: string
    /**
     * Where focus goes when the dialog is cancelled; `false` leaves it to the caller (who is
     * closing something else that takes it). Without an element, or when that is gone, the
     * calendar area gets it.
     */
    returnFocusTo?: HTMLElement | false | null
  }>(),
  { action: 'edit', eventTitle: '', returnFocusTo: null },
)

const emit = defineEmits<{
  'update:open': [open: boolean]
  choose: [scope: ScopeChoice]
}>()
useBackDismiss(toRef(props, 'open'), () => emit('update:open', false))

// A row is a 44 px target in full: the radio's pseudo-element spreads over the whole row.
const RADIO_UI = {
  item: 'relative min-h-11 items-center',
  base: 'before:absolute before:inset-0',
  fieldset: 'gap-1',
}

const items = computed(() =>
  SCOPE_CHOICES.map((value) => ({ label: tv(SCOPE_LABELS[value]), value })),
)
const choice = ref<ScopeChoice>('this')
let chosen = false

watch(
  () => props.open,
  (open) => {
    if (!open) return
    choice.value = 'this'
    chosen = false
  },
)

function onOpenChange(open: boolean) {
  emit('update:open', open)
}

function onContinue() {
  chosen = true
  emit('choose', choice.value)
}

// The first tab stop would be the close button; the question is the radio group.
function focusChoice(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  const content = event.target
  if (!(content instanceof HTMLElement)) return
  const radio =
    content.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
    content.querySelector<HTMLElement>('[role="radio"]')
  if (!radio) return
  event.preventDefault()
  radio.focus()
}

function restoreFocus(event: Event) {
  event.preventDefault()
  if (chosen || props.returnFocusTo === false) return
  pickFocusTarget(
    props.returnFocusTo,
    document.querySelector<HTMLElement>('[data-calendar-main]'),
  )?.focus()
}
</script>
