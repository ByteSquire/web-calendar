<!--
  Adds a rule for a person (picked from the people who signed in once), a group (its name as the Groups page
  shows it) or everyone signed in, with a plain description of each level. Adding someone who has a
  rule already changes their level. The parent saves and says whether it worked; only then are the
  inputs cleared.
-->
<template>
  <form
    class="flex flex-col gap-4"
    novalidate
    aria-labelledby="access-add-heading"
    :aria-busy="busy"
    @submit.prevent="submit"
  >
    <h2 id="access-add-heading" class="text-lg font-semibold">{{ t('Add access') }}</h2>

    <URadioGroup
      v-model="type"
      :legend="t('Give access to')"
      :items="whoItems"
      :ui="RADIO_UI"
      orientation="vertical"
    />

    <UFormField v-if="type === 'user'" :label="t('Person')" :error="problem" required>
      <USelectMenu
        v-model="person"
        :items="personItems"
        value-key="value"
        :search-input="SEARCH_PEOPLE"
        :placeholder="t('Choose a person')"
        class="w-full max-w-md"
        :ui="{ base: 'min-h-11', item: 'min-h-11 items-center' }"
      >
        <template #empty>{{
          t('Nobody matches. People appear here after they signed in once.')
        }}</template>
      </USelectMenu>
    </UFormField>

    <UFormField
      v-else-if="type === 'group'"
      :label="t('Group name')"
      :help="t('The name of a group from the Groups page, for example staff.')"
      :error="problem"
      required
    >
      <UInput
        v-model="group"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        class="w-full max-w-md"
      />
    </UFormField>

    <p v-else class="text-toned">
      {{ t('Everyone who can sign in to this calendar app gets this access.') }}
    </p>

    <URadioGroup
      v-model="levelModel"
      :legend="t('Access level')"
      :items="levelItems"
      :ui="RADIO_UI"
      orientation="vertical"
    />

    <div>
      <UButton type="submit" :label="t('Add access')" icon="i-lucide-plus" :loading="busy" />
    </div>
  </form>
</template>

<script setup lang="ts" generic="P extends string">
import type { Ref } from 'vue'
import { t, tv } from '~/utils/i18n'
import {
  PRINCIPAL_CHOICES,
  isGroupName,
  userLabel,
  type AccessPrincipalType,
  type AccessUser,
} from '~/utils/admin/access'

const props = defineProps<{
  users: readonly AccessUser[]
  busy: boolean
  /** The levels to choose from (calendars: read/write, resources: read/book/manage). */
  levels: readonly { value: P; label: string; help: string }[]
  /** The level that is selected at first. */
  defaultLevel: P
  /** Saves the rule; true when it worked. `label` names who it is for. */
  save: (
    rule: { principalType: AccessPrincipalType; principal: string | null; permission: P },
    label: string,
  ) => Promise<boolean>
}>()

// The search field is named; a placeholder is no name for assistive technology.
const SEARCH_PEOPLE = computed(() => ({
  placeholder: t('Search people'),
  'aria-label': t('Search people'),
}))
// 44 px rows for the radio buttons (design §9).
const RADIO_UI = { item: 'min-h-11 items-center' }

const type = ref<AccessPrincipalType>('user')
const person = ref<string | undefined>(undefined)
const group = ref('')
const permission = ref(props.defaultLevel) as Ref<P>
const problem = ref<string | undefined>(undefined)

const whoItems = computed(() =>
  PRINCIPAL_CHOICES.map((choice) => ({ ...choice, label: tv(choice.label) })),
)
// Nuxt UI types the radio group by its items; a plain string keeps that simple while the saved rule
// keeps the caller's own level type `P`.
const levelItems = computed(() =>
  props.levels.map((level) => ({
    value: level.value as string,
    label: tv(level.label),
    description: tv(level.help),
  })),
)
const levelModel = computed<string>({
  get: () => permission.value,
  set: (value) => {
    permission.value = value as P
  },
})
const personItems = computed(() =>
  props.users.map((user) => ({ value: user.sub, label: userLabel(user) })),
)

watch(type, () => {
  problem.value = undefined
})

async function submit() {
  problem.value = undefined
  if (type.value === 'user') {
    const chosen = props.users.find((user) => user.sub === person.value)
    if (!chosen) {
      problem.value = t('Choose a person.')
      return
    }
    if (
      await props.save(
        { principalType: 'user', principal: chosen.sub, permission: permission.value },
        userLabel(chosen),
      )
    ) {
      person.value = undefined
    }
  } else if (type.value === 'group') {
    const name = group.value.trim()
    if (!isGroupName(name)) {
      problem.value = t('Enter the group name: letters, digits, dots, dashes and underscores.')
      return
    }
    if (
      await props.save(
        { principalType: 'group', principal: name, permission: permission.value },
        name,
      )
    ) {
      group.value = ''
    }
  } else {
    await props.save(
      { principalType: 'authenticated', principal: null, permission: permission.value },
      t('Everyone signed in'),
    )
  }
}
</script>
