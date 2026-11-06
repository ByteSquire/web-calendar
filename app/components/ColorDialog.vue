<!--
  Picks a colour (SettingsColorPicker: the named colours, "Custom" for any colour, and whatever
  `choices` adds, such as "Default"). It reports the choice; the caller saves it and closes the
  dialog, or sets `error` to keep it open with the reason. Used for the viewer's colour of a calendar
  and for a category's colour.
-->
<template>
  <UModal
    :open="open"
    :title="title"
    :description="description"
    :ui="{ title: 'wrap-anywhere' }"
    @update:open="(next: boolean) => !next && close()"
  >
    <template #body>
      <form
        :id="formId"
        novalidate
        class="flex flex-col gap-3"
        @submit.prevent="emit('save', color)"
      >
        <SettingsColorPicker v-model="color" :choices="choices" />
        <SettingsErrorAlert v-if="error" :message="error" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('Cancel')"
          color="neutral"
          variant="outline"
          :disabled="pending"
          @click="close"
        />
        <UButton
          type="submit"
          :form="formId"
          :label="pending ? t('Saving…') : t('Save')"
          :aria-busy="pending"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'
import type { ColorChoice } from '~/utils/settings/palette'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    choices: ColorChoice[]
    /** The colour shown when the dialog opens: a choice's value or a `#rrggbb`. */
    value: string
    pending?: boolean
    error?: string | null
  }>(),
  { description: undefined, pending: false, error: null },
)
const emit = defineEmits<{ close: []; save: [color: string] }>()

const formId = `color-${useId()}`
const color = ref(props.value)
watch(
  () => [props.open, props.value] as const,
  ([open, value]) => {
    if (open) color.value = value
  },
)

function close() {
  if (!props.pending) emit('close')
}
</script>
