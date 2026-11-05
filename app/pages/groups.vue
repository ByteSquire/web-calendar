<!--
  Groups (for everybody signed in): the groups a person is in, with their members and calendars.
  Members create, rename, recolour, delete and share their group's calendars. Admins also create
  custom groups, change their members and delete them, and import groups of the identity provider
  (their members follow each sign-in); imported groups and the group of everyone stay read-only. The
  page shows admin controls to admins only, and the server checks every change again. Each part
  loads and reports its own errors, so one failing call leaves the rest of the page working.
  Choosing a group opens it below the list, and focus moves there, as on the resources page.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to calendar') }}
      </NuxtLink>
      <h1 ref="pageHeading" tabindex="-1" class="text-2xl font-semibold outline-none">
        {{ t('Groups') }}
      </h1>
    </header>

    <p>
      {{
        t(
          'Groups share calendars. Open a group to see its members and calendars, create calendars and share them with people or other groups.',
        )
      }}
    </p>

    <div
      v-if="checking || (groups.pending.value && groups.data.value === null)"
      role="status"
      class="flex flex-col gap-2"
    >
      <span class="sr-only">{{ t('Loading groups') }}</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <SettingsErrorAlert
      v-if="groups.error.value"
      :message="groups.error.value"
      retryable
      @retry="groups.reload()"
    />
    <SettingsErrorAlert v-if="problem" :message="problem" />
    <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>

    <p v-if="list.length === 0 && loaded" data-group-none class="text-toned">
      {{
        admin
          ? t('There are no groups yet. Create the first one below.')
          : t('You are not in a group yet. Ask an administrator to add you.')
      }}
    </p>

    <ul v-if="list.length > 0" :aria-label="t('Groups')" class="flex flex-col gap-2">
      <li
        v-for="group in list"
        :key="group.id"
        data-group
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3"
        :class="selectedId === group.id ? 'border-primary' : 'border-default'"
      >
        <div class="min-w-0 flex-1 basis-48">
          <p class="font-medium wrap-anywhere">{{ group.name }}</p>
          <p class="text-sm text-toned">
            {{ sourceLabel(group.source) }} ·
            {{ tc('{count} member | {count} members', group.memberCount) }}
          </p>
        </div>
        <UBadge
          v-if="group.member"
          :label="t('You are a member')"
          icon="i-lucide-user-check"
          color="neutral"
          variant="outline"
        />
        <div class="flex flex-wrap gap-2">
          <UButton
            :aria-label="t('Open {name}', { name: group.name })"
            :aria-pressed="selectedId === group.id"
            icon="i-lucide-folder-open"
            :label="t('Open')"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="openGroup(group.id)"
          />
          <UButton
            v-if="admin && group.source === 'app'"
            :aria-label="t('Delete group {name}', { name: group.name })"
            icon="i-lucide-trash-2"
            :label="t('Delete')"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="askDeleteGroup(group)"
          />
        </div>
      </li>
    </ul>

    <GroupsCreateGroupForm v-if="admin" :busy="busy" :save="createGroup" />

    <section
      v-if="selectedId !== null"
      ref="detailSection"
      tabindex="-1"
      aria-labelledby="group-detail-heading"
      class="flex flex-col gap-6 outline-none"
    >
      <div class="flex flex-col gap-1">
        <h2 id="group-detail-heading" class="text-xl font-semibold wrap-anywhere">
          {{ selectedName }}
        </h2>
      </div>

      <SettingsErrorAlert v-if="detailError" :message="detailError" retryable @retry="reopen" />
      <SettingsErrorAlert
        v-if="people.error.value"
        :message="people.error.value"
        retryable
        @retry="people.reload()"
      />
      <p v-if="people.data.value?.truncated" class="text-sm text-toned">
        {{
          t(
            'Not everybody is offered when you add members or share: the list shows the first {count} people, sorted by name.',
            { count: people.data.value.people.length },
          )
        }}
      </p>

      <div v-if="detailPending" role="status" class="flex flex-col gap-2">
        <span class="sr-only">{{ t('Loading the group') }}</span>
        <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
      </div>

      <template v-if="detail">
        <GroupsGroupMembers
          :key="`members-${detail.id}`"
          :group="detail"
          :people="people.data.value?.people ?? []"
          :busy="busy"
          :save-members="saveMembers"
        />
        <GroupsGroupCalendars
          :key="`calendars-${detail.id}`"
          :group="detail"
          :groups="groups.data.value ?? []"
          :people="people.data.value?.people ?? []"
          :busy="busy"
          :create-calendar="createCalendar"
          :update-calendar="updateCalendar"
          :delete-calendar="deleteCalendar"
          :share-calendar="shareCalendar"
        />
      </template>
    </section>

    <GroupsOidcGroups
      v-if="admin"
      :candidates="candidates.data.value?.candidates ?? null"
      :truncated="candidates.data.value?.truncated === true"
      :loading="candidates.pending.value"
      :error="candidates.error.value"
      :busy="busy"
      @reload="candidates.reload()"
      @import="importCandidate"
      @stop="askStopImporting"
    />

    <SettingsConfirmModal
      :open="stoppingCandidate !== null"
      :title="t('Stop importing {name}?', { name: stoppingCandidate?.name ?? '' })"
      :description="
        t(
          'The group, its members and the access rules that name it are removed here. Groups that still own calendars cannot be removed; delete their calendars first. The group stays in the list and can be imported again.',
        )
      "
      :confirm-label="t('Stop importing')"
      :busy="busy"
      :error="stopImportingError"
      :fallback="pageHeading"
      @update:open="(open) => (open ? undefined : closeStopImporting())"
      @confirm="confirmStopImporting"
    />

    <SettingsConfirmModal
      :open="deletingGroup !== null"
      :title="t('Delete {name}?', { name: deletingGroup?.name ?? '' })"
      :description="
        t(
          'The group is deleted. Groups that still own calendars cannot be deleted; delete their calendars first. This cannot be undone.',
        )
      "
      :confirm-label="t('Delete')"
      :busy="busy"
      :error="deleteGroupError"
      :fallback="pageHeading"
      @update:open="(open) => (open ? undefined : closeDeleteGroup())"
      @confirm="confirmDeleteGroup"
    />
  </div>
</template>

<script setup lang="ts">
import { useAdminFlag } from '~/composables/useAdminAccess'
import { useGroups, type CalendarBody } from '~/composables/useGroups'
import type { CalendarFormBody } from '~/components/groups/CalendarForm.vue'
import { N_, t, tc } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'
import {
  sourceLabel,
  type CalendarShare,
  type OidcCandidate,
  type GroupCalendar,
  type GroupDetail,
  type GroupPerson,
  type GroupSummary,
} from '~/utils/groups/model'
import { toShareInput } from '~/utils/groups/shares'

useHead({ title: () => t('Groups') })

const { admin: adminFlag, ensure } = useAdminFlag()
const api = useGroups()
const { groups, people, candidates } = api

const checking = ref(true)
const busy = ref(false)
const problem = ref<string | null>(null)
const notice = ref('')
const selectedId = ref<number | null>(null)
const detail = ref<GroupDetail | null>(null)
const detailPending = ref(false)
const detailError = ref<string | null>(null)
const detailSection = ref<HTMLElement | null>(null)
const pageHeading = ref<HTMLElement | null>(null)
const deletingGroup = ref<GroupSummary | null>(null)
const deleteGroupError = ref<string | null>(null)
const stoppingCandidate = ref<OidcCandidate | null>(null)
const stopImportingError = ref<string | null>(null)

const admin = computed(() => adminFlag.value === true)
// The server lists every group (the share dialog needs their names); the page shows a person
// their own, and an administrator all, so nobody is offered a group they may not open.
const list = computed(() => {
  const all = groups.data.value ?? []
  return admin.value ? all : all.filter((group) => group.member)
})
const loaded = computed(() => groups.data.value !== null && !groups.error.value)
const selectedName = computed(
  () => list.value.find((group) => group.id === selectedId.value)?.name ?? detail.value?.name ?? '',
)

async function start() {
  checking.value = true
  await ensure()
  checking.value = false
  await Promise.all([groups.reload(), people.reload(), admin.value ? candidates.reload() : null])
}

onMounted(start)

/** Runs one change; the lists are kept in step with what the server saved. */
async function run(job: () => Promise<string>): Promise<true | string> {
  if (busy.value) return 'busy'
  busy.value = true
  problem.value = null
  notice.value = ''
  try {
    notice.value = await job()
    return true
  } catch (cause) {
    return describeError(cause, N_('save the change'))
  } finally {
    busy.value = false
  }
}

async function openGroup(id: number) {
  selectedId.value = id
  await loadDetail()
  await nextTick()
  detailSection.value?.focus()
}

async function reopen() {
  await loadDetail()
}

async function loadDetail() {
  const id = selectedId.value
  if (id === null) return
  detail.value = null
  detailError.value = null
  detailPending.value = true
  try {
    const loaded = await api.loadGroup(id)
    if (selectedId.value === id) detail.value = loaded
  } catch (cause) {
    if (selectedId.value === id) {
      detailError.value = describeError(cause, N_('load the group'))
    }
  } finally {
    if (selectedId.value === id) detailPending.value = false
  }
}

/**
 * Replaces the detail and the list row's member count after the members changed. `id` is the group
 * the call was made for: an answer for a group that is no longer open changes nothing.
 */
function applyMembers(id: number, members: GroupPerson[]) {
  const current = detail.value
  if (!current || current.id !== id) return
  detail.value = { ...current, members }
  groups.update((all) =>
    all.map((group) =>
      group.id === current.id ? { ...group, memberCount: members.length } : group,
    ),
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

async function createGroup(name: string): Promise<true | string> {
  return run(async () => {
    const created = await api.createGroup(name)
    groups.update((all) => [...all, created].sort((a, b) => a.name.localeCompare(b.name)))
    return t('{name} was created.', { name: created.name })
  })
}

function askDeleteGroup(group: GroupSummary) {
  deleteGroupError.value = null
  deletingGroup.value = group
}

function closeDeleteGroup() {
  if (busy.value) return
  deletingGroup.value = null
}

async function confirmDeleteGroup() {
  const group = deletingGroup.value
  if (!group) return
  deleteGroupError.value = null
  const answer = await run(async () => {
    await api.deleteGroup(group.id)
    groups.update((all) => all.filter((item) => item.id !== group.id))
    if (selectedId.value === group.id) {
      selectedId.value = null
      detail.value = null
    }
    return t('{name} was deleted.', { name: group.name })
  })
  if (answer === true) deletingGroup.value = null
  else deleteGroupError.value = answer
}

/** Marks one candidate in the loaded list as imported (or not), as the server just saved it. */
function markCandidate(id: string, groupId: number | null) {
  candidates.update((data) => ({
    ...data,
    candidates: data.candidates.map((item) =>
      item.id === id
        ? { ...item, imported: groupId !== null, groupId, memberCount: 0, blocked: null }
        : item,
    ),
  }))
}

async function importCandidate(candidate: OidcCandidate): Promise<void> {
  const answer = await run(async () => {
    const created = await api.importGroup(candidate.id)
    groups.update((all) => [...all, created].sort((a, b) => a.name.localeCompare(b.name)))
    markCandidate(candidate.id, created.id)
    return t('{name} was imported. Its members are added as they sign in.', {
      name: created.name,
    })
  })
  if (answer !== true) problem.value = answer
}

function askStopImporting(candidate: OidcCandidate) {
  stopImportingError.value = null
  stoppingCandidate.value = candidate
}

function closeStopImporting() {
  if (busy.value) return
  stoppingCandidate.value = null
}

async function confirmStopImporting() {
  const candidate = stoppingCandidate.value
  if (!candidate || candidate.groupId === null) return
  const groupId = candidate.groupId
  stopImportingError.value = null
  const answer = await run(async () => {
    await api.stopImporting(groupId)
    groups.update((all) => all.filter((item) => item.id !== groupId))
    markCandidate(candidate.id, null)
    if (selectedId.value === groupId) {
      selectedId.value = null
      detail.value = null
    }
    return t('{name} is not imported any more.', { name: candidate.name })
  })
  if (answer === true) stoppingCandidate.value = null
  else stopImportingError.value = answer
}

async function saveMembers(members: string[]): Promise<true | string> {
  const id = detail.value?.id
  if (id === undefined) return t('This group no longer exists. Reload the page.')
  return run(async () => {
    const saved = await api.saveMembers(id, members)
    applyMembers(id, saved)
    return t('Members of {name} were saved.', { name: detail.value?.name ?? '' })
  })
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
    return t('{name} was added.', { name: saved.name })
  })
}

async function updateCalendar(calendar: GroupCalendar, body: CalendarBody): Promise<true | string> {
  const id = detail.value?.id
  if (id === undefined) return t('This group no longer exists. Reload the page.')
  return run(async () => {
    const saved = await api.updateCalendar(id, calendar.id, body)
    applyCalendar(id, saved)
    return t('{name} was saved.', { name: saved.name })
  })
}

async function deleteCalendar(calendar: GroupCalendar): Promise<true | string> {
  const id = detail.value?.id
  if (id === undefined) return t('This group no longer exists. Reload the page.')
  return run(async () => {
    await api.deleteCalendar(id, calendar.id)
    if (detail.value?.id === id) {
      detail.value = {
        ...detail.value,
        calendars: detail.value.calendars.filter((item) => item.id !== calendar.id),
      }
    }
    return t('{name} was deleted.', { name: calendar.name })
  })
}

async function shareCalendar(
  calendar: GroupCalendar,
  shares: CalendarShare[],
): Promise<true | string> {
  const id = detail.value?.id
  if (id === undefined) return t('This group no longer exists. Reload the page.')
  return run(async () => {
    const saved = await api.saveShares(id, calendar.id, toShareInput(shares))
    applyCalendar(id, saved)
    return t('Sharing of {name} was saved.', { name: saved.name })
  })
}
</script>
