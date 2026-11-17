<!--
  One group (/groups/<id>), for its members and for admins, opened from the list of the Groups page:
  its name, where it comes from and how many are in it, then its members (GroupMembers) and its
  calendars (GroupCalendars). Each change saves at once; the sections say what it came to in a toast
  and show a failure where it happened. The page loads the group, the people (whom members and
  shares may name) and the groups (whom shares may name, and the count of the built-in group)
  together, so nothing appears later and pushes the page down; when the people or groups could not
  be loaded, a Retry stands under the heading for those who would choose from them. A group the
  server does not show the person (403, 404) says so, under the link back to the list; any other
  failed load has Retry. The heading takes the focus once the page knows what it shows, as the
  heading of the page. Deleting a group stays on the list, beside the other groups.
-->
<template>
  <div ref="root" class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/groups" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to groups') }}
      </NuxtLink>
      <h1
        v-if="heading"
        ref="pageHeading"
        tabindex="-1"
        class="text-2xl font-semibold outline-none wrap-anywhere"
      >
        {{ heading }}
      </h1>
      <p v-if="detail" class="text-toned" data-group-summary>
        {{ sourceLabel(detail.source) }}
        <template v-if="memberCount !== null">
          · {{ tc('{count} member | {count} members', memberCount) }}
        </template>
      </p>
    </header>

    <div v-if="pending" role="status" class="flex flex-col gap-2">
      <span class="sr-only">{{ t('Loading the group') }}</span>
      <USkeleton class="h-8 w-full max-w-xs" aria-hidden="true" />
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <p v-else-if="missing" data-group-missing>
      {{ t('This group does not exist, or you are not one of its members.') }}
    </p>

    <SettingsErrorAlert v-else-if="loadError" :message="loadError" retryable @retry="load" />

    <template v-else-if="detail">
      <SettingsErrorAlert
        v-if="choicesError && (detail.canManageMembers || detail.canManageCalendars)"
        :message="choicesError"
        retryable
        @retry="reloadChoices"
      />
      <GroupsGroupMembers
        :key="`members-${detail.id}`"
        :group="detail"
        :people="people.data.value?.people ?? []"
        :people-truncated="people.data.value?.truncated === true"
        :busy="busy"
        :save-members="saveMembers"
        :save-managers="saveManagers"
      />
      <GroupsGroupCalendars
        :key="`calendars-${detail.id}`"
        :group="detail"
        :groups="groups.data.value ?? []"
        :people="people.data.value?.people ?? []"
        :people-truncated="people.data.value?.truncated === true"
        :busy="busy"
        :create-calendar="createCalendar"
        :share-calendar="shareCalendar"
        @saved="onCalendarSaved"
        @deleted="removeCalendar"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useGroups } from '~/composables/useGroups'
import type { CalendarFormBody } from '~/components/groups/CalendarForm.vue'
import { N_, t, tc } from '~/utils/i18n'
import { describeError, parseApiError } from '~/utils/settings/api-errors'
import {
  sourceLabel,
  type CalendarShare,
  type GroupCalendar,
  type GroupDetail,
  type GroupMember,
} from '~/utils/groups/model'
import { toShareInput } from '~/utils/groups/shares'

const route = useRoute()
const api = useGroups()
const { groups, people } = api

const root = useTemplateRef<HTMLElement>('root')
const pageHeading = useTemplateRef<HTMLElement>('pageHeading')
const detail = ref<GroupDetail | null>(null)
const pending = ref(true)
const missing = ref(false)
const loadError = ref<string | null>(null)
const busy = ref(false)

/** The id in the address; null when it is not one, which is a group that does not exist. */
const groupId = computed(() => {
  const raw = String(route.params.id ?? '')
  return /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null
})

const heading = computed(() => {
  if (detail.value) return detail.value.name
  if (missing.value) return t('Group not found')
  if (loadError.value) return t('Group')
  return null
})

useHead({ title: () => detail.value?.name ?? t('Groups') })

// The built-in group lists no members; its count comes with the list of groups.
const memberCount = computed(() => {
  const current = detail.value
  if (!current) return null
  if (current.source !== 'everyone') return current.members.length
  return groups.data.value?.find((group) => group.id === current.id)?.memberCount ?? null
})

const choicesError = computed(() => people.error.value ?? groups.error.value)

async function load() {
  const id = groupId.value
  detail.value = null
  missing.value = false
  loadError.value = null
  pending.value = true
  if (id === null) {
    missing.value = true
  } else {
    const [group] = await Promise.allSettled([api.loadGroup(id), groups.reload(), people.reload()])
    // The address changed while this was loading: the newer load shows its own group.
    if (groupId.value !== id) return
    if (group.status === 'fulfilled') {
      detail.value = group.value
    } else {
      const status = parseApiError(group.reason).status
      if (status === 403 || status === 404) missing.value = true
      else loadError.value = describeError(group.reason, N_('load the group'))
    }
  }
  pending.value = false
  await nextTick()
  focusHeading()
}

/** The heading of the page, unless the person has already moved on to something else. */
function focusHeading() {
  const active = document.activeElement
  const free = !active || active === document.body || root.value?.contains(active)
  if (free) pageHeading.value?.focus()
}

function reloadChoices() {
  void Promise.all([people.reload(), groups.reload()])
}

watch(groupId, () => void load())
onMounted(load)

/** Runs one change: true when it worked, else the words for the failure (the sections show them). */
async function run(job: () => Promise<void>): Promise<true | string> {
  if (busy.value) return t('Another change is still being saved. Try again in a moment.')
  busy.value = true
  try {
    await job()
    return true
  } catch (cause) {
    return describeError(cause, N_('save the change'))
  } finally {
    busy.value = false
  }
}

/** The group as the server saved it. `id` is the group the call was made for. */
function applyMembers(id: number, members: GroupMember[]) {
  const current = detail.value
  if (!current || current.id !== id) return
  detail.value = { ...current, members }
  groups.update((all) =>
    all.map((group) => (group.id === id ? { ...group, memberCount: members.length } : group)),
  )
}

function applyCalendar(id: number, saved: GroupCalendar) {
  const current = detail.value
  if (!current || current.id !== id) return
  const exists = current.calendars.some((item) => item.id === saved.id)
  detail.value = {
    ...current,
    calendars: exists
      ? current.calendars.map((item) => (item.id === saved.id ? saved : item))
      : [...current.calendars, saved],
  }
}

function onCalendarSaved(saved: GroupCalendar) {
  if (detail.value) applyCalendar(detail.value.id, saved)
}

function removeCalendar(calendarId: number) {
  const current = detail.value
  if (!current) return
  detail.value = {
    ...current,
    calendars: current.calendars.filter((item) => item.id !== calendarId),
  }
}

async function saveMembers(members: string[]): Promise<true | string> {
  const id = detail.value?.id
  if (id === undefined) return t('This group no longer exists. Reload the page.')
  return run(async () => applyMembers(id, await api.saveMembers(id, members)))
}

async function saveManagers(managers: string[]): Promise<true | string> {
  const id = detail.value?.id
  if (id === undefined) return t('This group no longer exists. Reload the page.')
  return run(async () => applyMembers(id, await api.saveManagers(id, managers)))
}

async function createCalendar(body: CalendarFormBody): Promise<true | string> {
  const id = detail.value?.id
  if (id === undefined) return t('This group no longer exists. Reload the page.')
  return run(async () => {
    const saved = await api.createCalendar(id, {
      name: body.name,
      ...(body.color ? { color: body.color } : {}),
    })
    applyCalendar(id, saved)
  })
}

async function shareCalendar(
  calendar: GroupCalendar,
  shares: CalendarShare[],
): Promise<true | string> {
  const id = detail.value?.id
  if (id === undefined) return t('This group no longer exists. Reload the page.')
  return run(async () => {
    applyCalendar(id, await api.saveShares(id, calendar.id, toShareInput(shares)))
  })
}
</script>
