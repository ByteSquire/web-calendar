<!--
  Creates a custom group (admins only; the page shows it to them only, the server checks again).
  The name is checked here as the server checks it, so a typo is named before the request. The
  parent's save returns true when the group exists, or the server's words for the failure.
-->
<template>
  <form
    class="flex flex-col gap-4"
    novalidate
    aria-labelledby="group-create-heading"
    :aria-busy="busy"
    @submit.prevent="submit"
  >
    <h2 id="group-create-heading" class="text-lg font-semibold">{{ t('Create a group') }}</h2>
    <p class="text-sm text-toned">
      {{
        t(
          'Members of a group can create and share its calendars. Its members are chosen here; groups from your identity provider cannot be changed here.',
        )
      }}
    </p>
    <SettingsErrorAlert v-if="alert" :message="alert" />

    <UFormField
      :label="t('Group name')"
      :help="t('Letters, digits, dots, dashes and underscores. It cannot be changed later.')"
      :error="problem"
      required
    >
      <UInput
        v-model="name"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        maxlength="64"
        class="w-full max-w-md"
      />
    </UFormField>

    <div>
      <UButton type="submit" :label="t('Create group')" icon="i-lucide-plus" :loading="busy" />
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

const name = ref('')
const problem = ref<string | undefined>(undefined)
const alert = ref<string | undefined>(undefined)

async function submit() {
  problem.value = groupNameProblem(name.value) ?? undefined
  alert.value = undefined
  if (problem.value) return
  const answer = await props.save(name.value)
  if (answer === true) name.value = ''
  else alert.value = answer
}
</script>
