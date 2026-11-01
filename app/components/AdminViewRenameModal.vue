<!--
  Renames a shared view (FR-2). It reports the new name; the caller saves it and closes the dialog,
  or sets `error` to keep it open.
-->
<template>
  <UModal
    :open="open"
    title="Rename shared view"
    description="Everybody sees the new name."
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
  defineProps<{ open: boolean; viewName: string; pending?: boolean; error?: string }>(),
  { pending: false, error: undefined },
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
