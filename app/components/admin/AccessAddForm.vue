<!--
  Adds a rule in one row: "Who" is one searchable list of everyone signed in, the groups of the
  Groups page (made here or imported, like the share dialog of a group calendar) and the people who
  signed in once, each with an icon of its kind and groups named "Group …"; "Level" is a select
  whose explanation of the chosen level stays under it (only its words change); then "Add". The row
  wraps on a small screen. Adding someone who has a rule already changes their level. The parent
  saves and says whether it worked; only then is "Who" cleared (the level stays for the next one).
  A missing choice is told on the field and nothing is sent.
-->
<template>
  <form
    class="flex flex-wrap items-start gap-3"
    novalidate
    :aria-label="t('Add access')"
    :aria-busy="busy"
    @submit.prevent="submit"
  >
    <UFormField :label="t('Who')" :error="problem" required class="min-w-0 flex-1 basis-56">
      <USelectMenu
        v-model="who"
        :items="whoItems"
        value-key="value"
        :icon="chosenIcon"
        :search-input="SEARCH"
        :placeholder="t('Choose a person or group')"
        class="w-full"
        :ui="{
          base: 'min-h-11',
          item: 'min-h-11 items-center',
          placeholder: 'truncate text-toned',
        }"
      >
        <template #empty>{{
          t('Nobody matches. People appear here after they signed in once.')
        }}</template>
      </USelectMenu>
    </UFormField>

    <UFormField
      :label="t('Level')"
      :help="chosenLevel ? tv(chosenLevel.help) : undefined"
      class="min-w-0 flex-1 basis-48"
    >
      <USelect v-model="levelModel" :items="levelItems" class="w-full" :ui="SELECT_UI" />
    </UFormField>

    <!-- Level with the fields, below their labels; on a phone it wraps under them. -->
    <div class="pt-6">
      <UButton type="submit" :label="t('Add')" icon="i-lucide-plus" :loading="busy" />
    </div>
  </form>
</template>

<script setup lang="ts" generic="P extends string">
import type { Ref } from 'vue'
import { t, tv } from '~/utils/i18n'
import { userLabel, type AccessPrincipalType, type AccessUser } from '~/utils/admin/access'

const props = defineProps<{
  users: readonly AccessUser[]
  /** The groups a rule can name: the app's own (`/api/groups`). */
  groups: readonly { name: string }[]
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
const SEARCH = computed(() => ({
  placeholder: t('Search people and groups'),
  'aria-label': t('Search people and groups'),
}))
// 44 px for the select and its options (design §9).
const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }
const ICONS: Record<AccessPrincipalType, string> = {
  user: 'i-lucide-user',
  group: 'i-lucide-users',
  authenticated: 'i-lucide-globe',
}
const EVERYONE = 'authenticated'

// One value per choice: `authenticated`, `group:<name>` or `user:<sub>`.
const who = ref<string | undefined>(undefined)
const permission = ref(props.defaultLevel) as Ref<P>
const problem = ref<string | undefined>(undefined)

// Three groups with a line between them: everyone, the groups, the people.
const whoItems = computed(() =>
  [
    [{ value: EVERYONE, label: t('Everyone signed in'), icon: ICONS.authenticated }],
    props.groups.map((item) => ({
      value: `group:${item.name}`,
      label: t('Group {name}', { name: item.name }),
      icon: ICONS.group,
    })),
    props.users.map((user) => ({
      value: `user:${user.sub}`,
      label: userLabel(user),
      icon: ICONS.user,
    })),
  ].filter((group) => group.length > 0),
)
const chosenIcon = computed(() =>
  who.value === undefined ? undefined : ICONS[parse(who.value).principalType],
)
// Nuxt UI types the select by its items; a plain string keeps that simple while the saved rule
// keeps the caller's own level type `P`.
const levelItems = computed(() =>
  props.levels.map((level) => ({ value: level.value as string, label: tv(level.label) })),
)
const levelModel = computed<string>({
  get: () => permission.value,
  set: (value) => {
    permission.value = value as P
  },
})
const chosenLevel = computed(() => props.levels.find((level) => level.value === permission.value))

watch(who, () => {
  problem.value = undefined
})

function parse(value: string): { principalType: AccessPrincipalType; principal: string | null } {
  if (value.startsWith('group:')) return { principalType: 'group', principal: value.slice(6) }
  if (value.startsWith('user:')) return { principalType: 'user', principal: value.slice(5) }
  return { principalType: 'authenticated', principal: null }
}

/** Who the choice names, and in which words, while the lists still have it. */
function chosen(): {
  principalType: AccessPrincipalType
  principal: string | null
  label: string
} | null {
  if (who.value === undefined) return null
  const { principalType, principal } = parse(who.value)
  if (principalType === 'authenticated') {
    return who.value === EVERYONE
      ? { principalType, principal, label: t('Everyone signed in') }
      : null
  }
  if (principalType === 'group') {
    const name = props.groups.find((item) => item.name === principal)?.name
    return name ? { principalType, principal: name, label: name } : null
  }
  const user = props.users.find((item) => item.sub === principal)
  return user ? { principalType, principal: user.sub, label: userLabel(user) } : null
}

async function submit() {
  problem.value = undefined
  const target = chosen()
  if (!target) {
    problem.value = t('Choose who gets access.')
    return
  }
  const saved = await props.save(
    {
      principalType: target.principalType,
      principal: target.principal,
      permission: permission.value,
    },
    target.label,
  )
  if (saved) who.value = undefined
}
</script>
