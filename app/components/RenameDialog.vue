<!--
  Gives something a new name (a view, a calendar, a category, a filter): one field, Save and Cancel.
  It reports the new name; the caller saves it and closes the dialog, or sets `error` to keep it open
  with the reason under the field. An empty name cannot be saved.
-->
<template>
  <UModal
    :open="open"
    :title="title"
    :description="description"
    :ui="{ title: 'wrap-anywhere' }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <form :id="formId" novalidate @submit.prevent="onSubmit">
        <UFormField :label="label ?? t('Name')" :error="error">
          <UInput v-model="name" :maxlength="maxlength" autocomplete="off" class="w-full" />
        </UFormField>
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
        <UButton
          type="submit"
          :form="formId"
          :label="t('Save')"
          :loading="pending"
          :disabled="name.trim() === ''"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    /** The field's label; "Name" when not given. */
    label?: string
    /** The current name, shown when the dialog opens. */
    value: string
    maxlength?: number
    pending?: boolean
    error?: string
  }>(),
  {
    description: undefined,
    label: undefined,
    maxlength: undefined,
    pending: false,
    error: undefined,
  },
)
const emit = defineEmits<{ 'update:open': [open: boolean]; save: [name: string] }>()

const formId = `rename-${useId()}`
const name = ref(props.value)
watch(
  () => props.open,
  (open) => {
    if (open) name.value = props.value
  },
)

function onSubmit() {
  const text = name.value.trim()
  if (text) emit('save', text)
}
</script>
