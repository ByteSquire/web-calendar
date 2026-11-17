<!--
  The form of the "New group" dialog on the Groups page (admins only; the page shows the button to
  them only, the server checks again). The name is checked here as the server checks it, so a typo
  is named at the field before the request. The parent's save returns true when the group exists
  (the parent then closes the dialog), or the server's words for the failure, which stay in the
  form. `focusFirst` puts the focus in the name field.
-->
<template>
  <form class="flex flex-col gap-4" novalidate :aria-busy="busy" @submit.prevent="submit">
    <SettingsErrorAlert v-if="alert" :message="alert" />

    <UFormField
      :label="t('Group name')"
      :help="t('Letters, digits, dots, dashes and underscores. It cannot be changed later.')"
      :error="problem"
      required
    >
      <UInput
        ref="nameInput"
        v-model="name"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        maxlength="64"
        class="w-full max-w-md"
      />
    </UFormField>

    <div class="flex flex-wrap gap-2">
      <UButton type="submit" :label="t('Create group')" icon="i-lucide-plus" :loading="busy" />
      <UButton
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
import { t } from '~/utils/i18n'
import { groupNameProblem } from '~/utils/groups/model'

const props = defineProps<{
  busy: boolean
  /** Saves the group; true when it worked, else the words for the failure. */
  save: (name: string) => Promise<true | string>
}>()
const emit = defineEmits<{ cancel: [] }>()

const name = ref('')
const problem = ref<string | undefined>(undefined)
const alert = ref<string | undefined>(undefined)
const nameInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('nameInput')

/** For the parent: the name field, where the form starts. */
function focusFirst() {
  nameInput.value?.inputRef?.focus()
}

defineExpose({ focusFirst })

async function submit() {
  if (props.busy) return
  problem.value = groupNameProblem(name.value) ?? undefined
  alert.value = undefined
  if (problem.value) return
  const answer = await props.save(name.value)
  if (answer !== true) alert.value = answer
}
</script>
