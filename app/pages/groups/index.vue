<!--
  Groups (for everybody signed in): the groups a person is in (an admin sees all), each with where
  it comes from, how many are in it and whether the person manages it, and "Open", which leads to
  the group's own page (/groups/<id>, pages/groups/[id].vue) with its members and calendars.
  Admins also create custom groups ("New group" beside the heading opens a small dialog), delete
  them (after asking, on the list, beside the other groups) and import groups of the identity
  provider (the section at the bottom; their members follow each sign-in). The page shows each
  control to those who may use it, and the server checks every change again. What a change came to
  is a toast; a failure is also told where it happened (in the dialog, or at the row of the
  provider's group), so nothing appears above the list and pushes it down. A failed load is shown
  where the list is, with Retry.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to calendar') }}
      </NuxtLink>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h1 ref="pageHeading" tabindex="-1" class="text-2xl font-semibold outline-none">
          {{ t('Groups') }}
        </h1>
        <UButton
          v-if="admin"
          ref="newGroupButton"
          :label="t('New group')"
          icon="i-lucide-plus"
          aria-haspopup="dialog"
          @click="openCreate"
        />
      </div>
    </header>

    <p>
      {{
        t(
          'Groups share calendars. Open a group to see its members and calendars. Its managers create calendars and share them with people or other groups.',
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

    <p v-if="list.length === 0 && loaded" data-group-none class="text-toned">
      {{
        admin
          ? t('There are no groups yet. Create the first one with “New group”.')
          : t('You are not in a group yet. Ask an administrator to add you.')
      }}
    </p>

    <ul v-if="list.length > 0" :aria-label="t('Groups')" class="flex flex-col gap-2">
      <li
        v-for="group in list"
        :key="group.id"
        data-group
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
      >
        <div class="min-w-0 flex-1 basis-48">
          <p class="font-medium wrap-anywhere">{{ group.name }}</p>
          <p class="text-sm text-toned">
            {{ sourceLabel(group.source) }} ·
            {{ tc('{count} member | {count} members', group.memberCount) }}
          </p>
        </div>
        <UBadge
          v-if="group.manager"
          :label="t('You manage this group')"
          icon="i-lucide-user-cog"
          color="neutral"
          variant="outline"
        />
        <UBadge
          v-else-if="group.member"
          :label="t('You are a member')"
          icon="i-lucide-user-check"
          color="neutral"
          variant="outline"
        />
        <div class="flex flex-wrap gap-2">
          <UButton
            :to="`/groups/${group.id}`"
            :aria-label="t('Open {name}', { name: group.name })"
            icon="i-lucide-folder-open"
            :label="t('Open')"
            color="neutral"
            variant="outline"
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

    <GroupsOidcGroups
      v-if="admin"
      :candidates="candidates.data.value?.candidates ?? null"
      :truncated="candidates.data.value?.truncated === true"
      :loading="candidates.pending.value"
      :error="candidates.error.value"
      :busy="busy"
      :row-error="importError"
      @reload="candidates.reload()"
      @import="importCandidate"
      @stop="askStopImporting"
    />

    <UModal
      :open="creating"
      :title="t('New group')"
      :description="
        t(
          'Members of a group can create and share its calendars. Its members are chosen here; groups from your identity provider cannot be changed here.',
        )
      "
      :content="{ onOpenAutoFocus: focusCreateForm, onCloseAutoFocus: createFocus.restore }"
      :ui="{ description: 'wrap-anywhere' }"
      @update:open="(open) => (open ? undefined : closeCreate())"
    >
      <template #body>
        <GroupsCreateGroupForm
          ref="createForm"
          :busy="busy"
          :save="createGroup"
          @cancel="closeCreate"
        />
      </template>
    </UModal>

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
import { useGroups } from '~/composables/useGroups'
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { N_, t, tc } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'
import { createFocusReturn } from '~/utils/settings/focus-return'
import { sourceLabel, type OidcCandidate, type GroupSummary } from '~/utils/groups/model'

useHead({ title: () => t('Groups') })

const { admin: adminFlag, ensure } = useAdminFlag()
const api = useGroups()
const { groups, candidates } = api
const notify = useNotify()

const checking = ref(true)
const busy = ref(false)
const pageHeading = ref<HTMLElement | null>(null)
const newGroupButton = useTemplateRef<{ $el: HTMLElement }>('newGroupButton')
const createForm = useTemplateRef<{ focusFirst: () => void }>('createForm')
const creating = ref(false)
const createFocus = createFocusReturn(() => newGroupButton.value?.$el ?? pageHeading.value)
const deletingGroup = ref<GroupSummary | null>(null)
const deleteGroupError = ref<string | null>(null)
const stoppingCandidate = ref<OidcCandidate | null>(null)
const stopImportingError = ref<string | null>(null)
const importError = ref<{ id: string; message: string } | null>(null)

const admin = computed(() => adminFlag.value === true)
// The server lists every group (the share dialog needs their names); the page shows a person
// their own, and an administrator all, so nobody is offered a group they may not open.
const list = computed(() => {
  const all = groups.data.value ?? []
  return admin.value ? all : all.filter((group) => group.member)
})
const loaded = computed(() => groups.data.value !== null && !groups.error.value)

async function start() {
  checking.value = true
  await ensure()
  checking.value = false
  await Promise.all([groups.reload(), admin.value ? candidates.reload() : null])
}

onMounted(start)

/**
 * Runs one change. The job returns what it came to, shown as a toast; a failure is a toast too and
 * comes back as words for the place where it happened (the dialog, the row).
 */
async function run(job: () => Promise<string>): Promise<true | string> {
  if (busy.value) return t('Another change is still being saved. Try again in a moment.')
  busy.value = true
  try {
    notify.done(await job())
    return true
  } catch (cause) {
    const message = describeError(cause, N_('save the change'))
    notify.failed(message)
    return message
  } finally {
    busy.value = false
  }
}

const byName = (a: GroupSummary, b: GroupSummary) => a.name.localeCompare(b.name)

function openCreate() {
  createFocus.remember()
  creating.value = true
}

function closeCreate() {
  if (!busy.value) creating.value = false
}

function focusCreateForm(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  createForm.value?.focusFirst()
}

/** The form keeps a failure; the dialog closes once the group exists. */
async function createGroup(name: string): Promise<true | string> {
  return run(async () => {
    const created = await api.createGroup(name)
    groups.update((all) => [...all, created].sort(byName))
    creating.value = false
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
  importError.value = null
  const answer = await run(async () => {
    const created = await api.importGroup(candidate.id)
    groups.update((all) => [...all, created].sort(byName))
    markCandidate(candidate.id, created.id)
    return t('{name} was imported. Its members are added as they sign in.', {
      name: created.name,
    })
  })
  if (answer !== true) importError.value = { id: candidate.id, message: answer }
}

function askStopImporting(candidate: OidcCandidate) {
  importError.value = null
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
    return t('{name} is not imported any more.', { name: candidate.name })
  })
  if (answer === true) stoppingCandidate.value = null
  else stopImportingError.value = answer
}
</script>
