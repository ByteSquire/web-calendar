<!--
  Adds a resource or changes one (name, type, place, capacity, description). The parent sends it
  and says whether it worked, with the server's messages per field in `errors`; only then is the
  form closed or cleared. Every field has a visible label.
-->
<template>
  <form
    class="flex flex-col gap-4"
    novalidate
    aria-labelledby="resource-form-heading"
    :aria-busy="busy"
    @submit.prevent="submit"
  >
    <h2 id="resource-form-heading" class="text-lg font-semibold">{{ heading }}</h2>

    <UFormField :label="t('Name')" :error="problem ?? errors.name" required>
      <UInput v-model="draft.name" autocomplete="off" class="w-full max-w-md" />
    </UFormField>

    <URadioGroup
      v-model="draft.type"
      :legend="t('Type')"
      :items="typeItems"
      :ui="{ item: 'min-h-11 items-center' }"
      orientation="horizontal"
    />
    <p v-if="errors.type" class="text-sm text-error">
      {{ t('Type {problem}.', { problem: errors.type }) }}
    </p>

    <UFormField :label="t('Location')" :error="errors.location">
      <UInput v-model="draft.location" autocomplete="off" class="w-full max-w-md" />
    </UFormField>

    <UFormField
      :label="t('Capacity')"
      :help="t('Leave empty for no limit.')"
      :error="capacityProblem ?? errors.capacity"
    >
      <UInput v-model="draft.capacity" inputmode="numeric" autocomplete="off" class="w-40" />
    </UFormField>

    <UFormField :label="t('Description')" :error="errors.description">
      <UTextarea v-model="draft.description" :rows="3" class="w-full max-w-md" />
    </UFormField>

    <div class="flex flex-wrap gap-2">
      <UButton type="submit" :label="submitLabel" :icon="submitIcon" :loading="busy" />
      <UButton
        v-if="cancellable"
        type="button"
        :label="t('Cancel')"
        color="neutral"
        variant="outline"
        :disabled="busy"
        @click="emit('cancel')"
      />
    </div>
  </form>
</template>

<script setup lang="ts">
import { t, tv } from '~/utils/i18n'
import { RESOURCE_TYPES, emptyDraft, toBody, type ResourceDraft } from '~/utils/admin/resources'

const props = defineProps<{
  /** Fills the form (editing); without it the form is empty (adding). */
  initial?: ResourceDraft
  /** The server's messages by field name. */
  errors: Record<string, string>
  busy: boolean
  cancellable?: boolean
  /** Sends the body; true when it worked. */
  save: (body: NonNullable<ReturnType<typeof toBody>>) => Promise<boolean>
}>()
const emit = defineEmits<{ cancel: [] }>()

const typeItems = computed(() =>
  RESOURCE_TYPES.map((type) => ({ value: type.value, label: tv(type.label) })),
)
const draft = reactive<ResourceDraft>({ ...(props.initial ?? emptyDraft()) })
const problem = ref<string | undefined>(undefined)
const capacityProblem = ref<string | undefined>(undefined)

const editing = computed(() => props.initial !== undefined)
const heading = computed(() => (editing.value ? t('Edit resource') : t('Add resource')))
const submitLabel = computed(() => (editing.value ? t('Save changes') : t('Add resource')))
const submitIcon = computed(() => (editing.value ? 'i-lucide-save' : 'i-lucide-plus'))

async function submit() {
  problem.value = undefined
  capacityProblem.value = undefined
  if (draft.name.trim() === '') {
    problem.value = t('Enter a name.')
    return
  }
  const body = toBody(draft)
  if (!body) {
    capacityProblem.value = t('Enter a whole number, or leave it empty.')
    return
  }
  if ((await props.save(body)) && !editing.value) Object.assign(draft, emptyDraft())
}
</script>
