<!--
  The members of a group, each with a "Manager" badge when they manage it. Groups from the identity
  provider and groups the person may not change are a plain list with a marker that says where they
  are managed; the built-in group of everyone who signed in recently has no list, only the note.
  Managers and admins of a custom group change the members, and each change is saved at once (PUT
  members with the saved list plus or minus the one person): "Add" under the list picks one of the
  people who signed in once; "Remove" names the person and asks first. Only an admin removes a
  manager, so a manager sees no Remove on one. What a change came to is a toast; a failure is a toast
  too and is also shown where it happened: under the Add row, in the dialog, or at the member's row.
  Whether the people offered are not everybody is said under the Add row.

  Admins name the managers: "Make manager" and "Remove as manager" on a member's row, saved at once
  (PUT managers). It is an admin-only control, but no existing menu or place holds a role of a
  member; the member's own row is the place it belongs to, so nothing new is added to the page.
-->
<template>
  <section aria-labelledby="group-members-heading" class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <h2
        id="group-members-heading"
        ref="heading"
        tabindex="-1"
        class="text-lg font-semibold outline-none"
      >
        {{ t('Members') }}
      </h2>
      <UBadge
        v-if="group.source !== 'app'"
        :label="sourceLabel(group.source)"
        :icon="group.source === 'oidc' ? 'i-lucide-cloud' : 'i-lucide-users'"
        color="neutral"
        variant="outline"
      />
    </div>

    <p v-if="group.source === 'oidc'" class="text-sm text-toned" data-imported-note>
      {{
        t(
          'This group is imported from your identity provider. Its members are changed there, not here. A person is added or removed when they sign in.',
        )
      }}
    </p>
    <p v-else-if="group.source === 'everyone'" class="text-sm text-toned" data-everyone-note>
      {{
        t(
          'Everyone whose last sign-in was at most {days} ago is in this group. It is built by the app and cannot be changed.',
          { days: tc('{count} day | {count} days', windowDays) },
        )
      }}
    </p>

    <p
      v-if="group.source !== 'everyone' && saved.length === 0"
      class="text-toned"
      data-members-none
    >
      {{ t('This group has no members yet.') }}
    </p>
    <ul
      v-else-if="group.source !== 'everyone'"
      :aria-label="t('Members')"
      class="flex flex-col gap-2"
    >
      <li
        v-for="sub in saved"
        :key="sub"
        data-group-member
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
      >
        <UIcon name="i-lucide-user" class="size-5 shrink-0" aria-hidden="true" />
        <p class="min-w-0 flex-1 basis-48 font-medium wrap-anywhere">{{ labelOf(sub) }}</p>
        <UBadge
          v-if="managers.includes(sub)"
          :label="t('Manager')"
          icon="i-lucide-user-cog"
          color="neutral"
          variant="subtle"
        />
        <UButton
          v-if="group.canNameManagers"
          :aria-label="
            managers.includes(sub)
              ? t('Remove as manager of {group}: {name}', { name: labelOf(sub), group: group.name })
              : t('Make manager of {group}: {name}', { name: labelOf(sub), group: group.name })
          "
          :icon="managers.includes(sub) ? 'i-lucide-user-x' : 'i-lucide-user-cog'"
          :label="managers.includes(sub) ? t('Remove as manager') : t('Make manager')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="toggleManager(sub)"
        />
        <UButton
          v-if="editable && (group.canNameManagers || !managers.includes(sub))"
          :aria-label="t('Remove {name} from {group}', { name: labelOf(sub), group: group.name })"
          icon="i-lucide-user-minus"
          :label="t('Remove')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="askRemove(sub)"
        />
        <SettingsErrorAlert
          v-if="rowError?.sub === sub"
          :message="rowError.message"
          class="basis-full"
        />
      </li>
    </ul>

    <form
      v-if="editable"
      class="flex flex-col gap-3"
      novalidate
      aria-labelledby="group-members-add-heading"
      :aria-busy="busy"
      @submit.prevent="add"
    >
      <h3 id="group-members-add-heading" class="font-medium">{{ t('Add a member') }}</h3>
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
          :loading="adding"
          :disabled="busy || !picked"
        />
      </div>
      <SettingsErrorAlert v-if="addError" :message="addError" />
      <p v-if="peopleTruncated" class="text-sm text-toned">
        {{
          t(
            'Not everybody is offered when you add members or share: the list shows the first {count} people, sorted by name.',
            { count: people.length },
          )
        }}
      </p>
    </form>

    <SettingsConfirmModal
      :open="removing !== null"
      :title="t('Remove {name} from {group}?', { name: removingName, group: group.name })"
      :description="t('They no longer see the calendars of the group or what is shared with it.')"
      :confirm-label="t('Remove')"
      :busy="busy"
      :error="removeError"
      :fallback="heading"
      @update:open="(open) => (open ? undefined : closeRemove())"
      @confirm="confirmRemove"
    />
  </section>
</template>

<script setup lang="ts">
import { userLabel } from '~/utils/admin/access'
import { t, tc } from '~/utils/i18n'
import {
  addMember,
  removeMember,
  sourceLabel,
  type GroupDetail,
  type GroupPerson,
} from '~/utils/groups/model'

const props = defineProps<{
  group: GroupDetail
  people: readonly GroupPerson[]
  /** More people signed in than `people` holds (the server cuts the list). */
  peopleTruncated?: boolean
  busy: boolean
  /** Saves the complete member list; true when it worked, else the words for the failure. */
  saveMembers: (members: string[]) => Promise<true | string>
  /** Saves the complete list of managers (admins); true when it worked, else the failure. */
  saveManagers: (managers: string[]) => Promise<true | string>
}>()

const notify = useNotify()

// How long a sign-in keeps a person in the group of everyone (NUXT_SIGNIN_WINDOW_DAYS).
const serverConfig = useServerConfigState()
const windowDays = computed(() => serverConfig.value?.signinWindowDays ?? 30)

// Only custom groups whose members the person may change (the server says so); the buttons are
// hidden, the server still decides.
const editable = computed(() => props.group.source === 'app' && props.group.canManageMembers)
const SEARCH_PEOPLE = computed(() => ({
  placeholder: t('Search people'),
  'aria-label': t('Search people'),
}))

const heading = useTemplateRef<HTMLElement>('heading')
const saved = computed(() => props.group.members.map((member) => member.sub))
const managers = computed(() =>
  props.group.members.filter((member) => member.manager).map((member) => member.sub),
)
const picked = ref<string | undefined>(undefined)
const adding = ref(false)
const addError = ref<string | null>(null)
const removing = ref<string | null>(null)
// Kept while the dialog closes, so its title does not change as it fades.
const removingName = ref('')
const removeError = ref<string | null>(null)
const rowError = ref<{ sub: string; message: string } | null>(null)

// A new choice starts afresh: the failure belonged to the last one.
watch(picked, () => {
  addError.value = null
})

function labelOf(sub: string): string {
  const known =
    props.group.members.find((member) => member.sub === sub) ??
    props.people.find((person) => person.sub === sub)
  return known ? userLabel(known) : t('Unnamed person')
}

const choices = computed(() =>
  props.people
    .filter((person) => !saved.value.includes(person.sub))
    .map((person) => ({ value: person.sub, label: userLabel(person) })),
)

async function add() {
  const sub = picked.value
  if (!sub || props.busy) return
  addError.value = null
  rowError.value = null
  const name = labelOf(sub)
  adding.value = true
  const answer = await props.saveMembers(addMember(saved.value, sub))
  adding.value = false
  if (answer === true) {
    picked.value = undefined
    notify.done(t('{name} was added to {group}.', { name, group: props.group.name }))
  } else {
    addError.value = answer
    notify.failed(answer)
  }
}

function askRemove(sub: string) {
  rowError.value = null
  removeError.value = null
  removingName.value = labelOf(sub)
  removing.value = sub
}

function closeRemove() {
  if (!props.busy) removing.value = null
}

async function confirmRemove() {
  const sub = removing.value
  if (sub === null) return
  removeError.value = null
  const name = labelOf(sub)
  const answer = await props.saveMembers(removeMember(saved.value, sub))
  if (answer === true) {
    removing.value = null
    notify.done(t('{name} was removed from {group}.', { name, group: props.group.name }))
  } else {
    removeError.value = answer
    notify.failed(answer)
  }
}

async function toggleManager(sub: string) {
  if (props.busy) return
  rowError.value = null
  const name = labelOf(sub)
  const was = managers.value.includes(sub)
  const next = was ? managers.value.filter((manager) => manager !== sub) : [...managers.value, sub]
  const answer = await props.saveManagers(next)
  if (answer === true) {
    notify.done(
      was
        ? t('{name} no longer manages {group}.', { name, group: props.group.name })
        : t('{name} manages {group} now.', { name, group: props.group.name }),
    )
  } else {
    rowError.value = { sub, message: answer }
    notify.failed(answer)
  }
}
</script>
