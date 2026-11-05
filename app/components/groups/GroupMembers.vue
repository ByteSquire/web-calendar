<!--
  The members of a group. Imported (Kanidm) groups and groups the person may not change are a
  plain list with a marker that says where they are managed. Admins on a custom group get a list
  they edit and save as one complete list (PUT members); removing a person is a button that names
  them, and adding picks from the people who signed in once.
-->
<template>
  <section aria-labelledby="group-members-heading" class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <h3 id="group-members-heading" class="text-lg font-semibold">{{ t('Members') }}</h3>
      <UBadge
        v-if="group.source === 'kanidm'"
        :label="t('From Kanidm')"
        icon="i-lucide-cloud"
        color="neutral"
        variant="outline"
      />
    </div>

    <p v-if="group.source === 'kanidm'" class="text-sm text-toned" data-kanidm-note>
      {{
        t(
          'This group is imported from Kanidm. Its members are changed there, not here. The list is updated from Kanidm regularly.',
        )
      }}
    </p>

    <SettingsErrorAlert v-if="alert" :message="alert" />

    <p v-if="draft.length === 0" class="text-toned" data-members-none>
      {{ t('This group has no members yet.') }}
    </p>
    <ul v-else :aria-label="t('Members')" class="flex flex-col gap-2">
      <li
        v-for="sub in draft"
        :key="sub"
        data-group-member
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
      >
        <UIcon name="i-lucide-user" class="size-5 shrink-0" aria-hidden="true" />
        <p class="min-w-0 flex-1 basis-48 font-medium wrap-anywhere">{{ labelOf(sub) }}</p>
        <UButton
          v-if="editable"
          :aria-label="t('Remove {name} from {group}', { name: labelOf(sub), group: group.name })"
          icon="i-lucide-user-minus"
          :label="t('Remove')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="remove(sub)"
        />
      </li>
    </ul>

    <form
      v-if="editable"
      class="flex flex-col gap-3"
      novalidate
      aria-labelledby="group-members-add-heading"
      @submit.prevent="add"
    >
      <h4 id="group-members-add-heading" class="font-medium">{{ t('Add a member') }}</h4>
      <div class="flex flex-wrap items-end gap-2">
        <UFormField :label="t('Person')" class="min-w-0 flex-1 basis-56">
          <USelectMenu
            v-model="picked"
            :items="choices"
            value-key="value"
            :search-input="SEARCH_PEOPLE"
            :placeholder="t('Choose a person')"
            :disabled="busy"
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
        <UButton
          type="submit"
          :label="t('Add')"
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          :disabled="busy || !picked"
        />
      </div>
    </form>

    <div v-if="editable && changed" class="flex flex-wrap gap-2">
      <UButton :label="t('Save members')" icon="i-lucide-save" :loading="busy" @click="save" />
      <UButton
        :label="t('Undo changes')"
        color="neutral"
        variant="outline"
        :disabled="busy"
        @click="reset"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { userLabel } from '~/utils/admin/access'
import { t } from '~/utils/i18n'
import { addMember, removeMember, type GroupDetail, type GroupPerson } from '~/utils/groups/model'

const props = defineProps<{
  group: GroupDetail
  people: readonly GroupPerson[]
  busy: boolean
  /** Saves the complete member list; true when it worked, else the words for the failure. */
  saveMembers: (members: string[]) => Promise<true | string>
}>()

// Only custom groups whose members the person may change (the server says so); the buttons are
// hidden, the server still decides.
const editable = computed(() => props.group.source === 'app' && props.group.canManageMembers)
const SEARCH_PEOPLE = computed(() => ({
  placeholder: t('Search people'),
  'aria-label': t('Search people'),
}))

const saved = computed(() => props.group.members.map((member) => member.sub))
const draft = ref<string[]>([...saved.value])
const picked = ref<string | undefined>(undefined)
const alert = ref<string | undefined>(undefined)

watch(saved, (next) => {
  draft.value = [...next]
})

const changed = computed(
  () =>
    draft.value.length !== saved.value.length ||
    draft.value.some((sub, i) => sub !== saved.value[i]),
)

function labelOf(sub: string): string {
  const known =
    props.group.members.find((member) => member.sub === sub) ??
    props.people.find((person) => person.sub === sub)
  return known ? userLabel(known) : t('Unnamed person')
}

const choices = computed(() =>
  props.people
    .filter((person) => !draft.value.includes(person.sub))
    .map((person) => ({ value: person.sub, label: userLabel(person) })),
)

function add() {
  if (!picked.value) return
  draft.value = addMember(draft.value, picked.value)
  picked.value = undefined
}

function remove(sub: string) {
  draft.value = removeMember(draft.value, sub)
}

function reset() {
  draft.value = [...saved.value]
  alert.value = undefined
}

async function save() {
  alert.value = undefined
  const answer = await props.saveMembers([...draft.value])
  if (answer !== true) alert.value = answer
}
</script>
