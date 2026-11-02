<!--
  Renames a view (FR-2): a shared one by default, a user's own with `shared` false. It reports the
  new name; the caller saves it and closes the dialog, or sets `error` to keep it open.
-->
<template>
  <UModal
    :open="open"
    :title="shared ? 'Rename shared view' : 'Rename view'"
    :description="shared ? 'Everybody sees the new name.' : 'Only you see this view.'"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <form id="admin-view-rename-form" @submit.prevent="onSubmit">
        <UFormField label="Name" :error="error">
          <UInput v-model="name" autocomplete="off" class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          label="Cancel"
          color="neutral"
          variant="outline"
          @click="emit('update:open', false)"
        />
        <UButton
          type="submit"
          form="admin-view-rename-form"
          label="Save"
          :loading="pending"
          :disabled="name.trim() === ''"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
const props = withDefaults(
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

const name = ref(props.viewName)
watch(
  () => props.open,
  (open) => {
    if (open) name.value = props.viewName
  },
)

function onSubmit() {
  const text = name.value.trim()
  if (text) emit('save', text)
}
</script>
