<!--
  One calendar of a group, in a dialog, for the group's managers and for admins: its name and
  colour (the same form as on the Groups page), who else it is shared with (a sentence, and "Change
  sharing", which opens the share dialog of the Groups page over this one), and Delete (after
  asking). Opened from "Edit calendar" in the sidebar's menu of a group calendar, so a manager
  changes it where they are, without the Groups page. It loads the group when it opens (the
  calendar with its shares, and whether the person may still change it) and the people and groups
  the share dialog offers; after each change the calendar view is reloaded. The group routes check
  the caller themselves.
-->
<template>
  <UModal
    :open="target !== null"
    :title="calendar?.name ?? shownName"
    :description="detail ? t('A calendar of the group {group}.', { group: detail.name }) : ''"
    :ui="{ title: 'wrap-anywhere' }"
    @update:open="(open) => (open ? undefined : close())"
  >
    <template #body>
      <div class="flex flex-col gap-6" :aria-busy="loading || busy">
        <div v-if="loading" role="status" class="flex flex-col gap-2">
          <span class="sr-only">{{ t('Loading the group') }}</span>
          <USkeleton class="h-11 w-full" aria-hidden="true" />
        </div>
        <SettingsErrorAlert v-if="loadError" :message="loadError" />
        <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>

        <template v-if="calendar && detail">
          <p v-if="!detail.canManageCalendars" class="text-toned" data-group-calendar-read-only>
            {{ t('Only the managers of the group and administrators change this calendar.') }}
          </p>
          <template v-else>
            <GroupsCalendarForm
              :key="`group-calendar-${calendar.id}`"
              :initial="calendar"
              :busy="busy"
              cancellable
              :save="saveDetails"
              @cancel="close"
            />
            <section
              aria-labelledby="group-calendar-sharing"
              class="flex flex-col gap-2 border-t border-default pt-4"
            >
              <h3 id="group-calendar-sharing" class="font-semibold">{{ t('Sharing') }}</h3>
              <p class="text-sm text-toned wrap-anywhere">
                {{ shareSummary(calendar.shares, detail.name) }}
              </p>
              <UButton
                :label="t('Change sharing')"
                icon="i-lucide-share-2"
                color="neutral"
                variant="outline"
                class="self-start"
                :disabled="busy"
                @click="sharing = true"
              />
            </section>
            <section
              aria-labelledby="group-calendar-delete"
              class="flex flex-col gap-2 border-t border-default pt-4"
            >
              <h3 id="group-calendar-delete" class="font-semibold">{{ t('Delete calendar') }}</h3>
              <p class="text-sm text-toned">
                {{
                  t('The calendar, its events and its sharing are deleted. This cannot be undone.')
                }}
              </p>
              <UButton
                :label="t('Delete calendar')"
                icon="i-lucide-trash-2"
                color="error"
                variant="outline"
                class="self-start"
                :disabled="busy"
                @click="askDelete"
              />
            </section>
          </template>
        </template>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton
          :label="t('Close')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="close"
        />
      </div>
    </template>
  </UModal>

  <GroupsCalendarShareDialog
    :open="sharing && calendar !== null"
    :calendar="calendar"
    :group-name="detail?.name ?? ''"
    :groups="api.groups.data.value ?? []"
    :people="api.people.data.value?.people ?? []"
    :busy="busy"
    :save="saveShares"
    @update:open="(open) => (sharing = open)"
  />

  <ConfirmDeleteDialog
    :open="deleting"
    :event-title="calendar?.name ?? ''"
    :detail="t('The calendar, its events and its sharing are deleted. This cannot be undone.')"
    :pending="busy"
    :error="deleteError"
    :return-focus-to="false"
    @update:open="(open) => (open ? undefined : closeDelete())"
    @confirm="confirmDelete"
  />
</template>

<script setup lang="ts">
import { useGroups, type CalendarBody } from '~/composables/useGroups'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import type { CalendarShare, GroupDetail } from '~/utils/groups/model'
import { shareSummary, toShareInput } from '~/utils/groups/shares'
import { N_, t } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'

const props = defineProps<{
  /** The calendar to edit: its group and its id on the server; null when the dialog is closed. */
  target: { groupId: number; calendarId: number; name: string } | null
}>()
const emit = defineEmits<{
  close: []
  /** The calendar was deleted; the words for it, for whoever shows them now. */
  deleted: [message: string]
}>()

const api = useGroups()
const status = useLiveStatus()
const detail = ref<GroupDetail | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const busy = ref(false)
const notice = ref('')
const sharing = ref(false)
const deleting = ref(false)
const deleteError = ref('')
// Kept while the dialog closes, so the title does not flash empty.
const shownName = ref('')

const calendar = computed(
  () => detail.value?.calendars.find((item) => item.id === props.target?.calendarId) ?? null,
)

watch(
  () => props.target,
  (target) => {
    if (!target) return
    shownName.value = target.name
    void load(target.groupId)
  },
  { immediate: true },
)

async function load(groupId: number) {
  detail.value = null
  loadError.value = null
  notice.value = ''
  sharing.value = false
  deleting.value = false
  loading.value = true
  try {
    const [loaded] = await Promise.all([
      api.loadGroup(groupId),
      // What the share dialog offers; it still opens if these fail.
      api.groups.reload(),
      api.people.reload(),
    ])
    if (props.target?.groupId !== groupId) return
    detail.value = loaded
    if (!loaded.calendars.some((item) => item.id === props.target?.calendarId)) {
      loadError.value = t('This calendar no longer exists. Reload the page.')
    }
  } catch (cause) {
    if (props.target?.groupId === groupId) {
      loadError.value = describeError(cause, N_('load the group'))
    }
  } finally {
    if (props.target?.groupId === groupId) loading.value = false
  }
}

/** Runs one change; the group is shown as the server saved it, and the calendar view reloads. */
async function run(job: () => Promise<string>, action: string): Promise<true | string> {
  if (busy.value) return t('Another change is still being saved. Try again in a moment.')
  busy.value = true
  notice.value = ''
  try {
    notice.value = await job()
    void status.refresh({ external: false })
    return true
  } catch (cause) {
    return describeError(cause, action)
  } finally {
    busy.value = false
  }
}

function replaceCalendar(saved: NonNullable<typeof calendar.value>) {
  const current = detail.value
  if (!current) return
  detail.value = {
    ...current,
    calendars: current.calendars.map((item) => (item.id === saved.id ? saved : item)),
  }
}

function saveDetails(body: CalendarBody): Promise<true | string> {
  const target = props.target
  if (!target) return Promise.resolve(t('This calendar no longer exists. Reload the page.'))
  return run(async () => {
    const saved = await api.updateCalendar(target.groupId, target.calendarId, body)
    replaceCalendar(saved)
    return t('{name} was saved.', { name: saved.name })
  }, N_('save the calendar'))
}

function saveShares(shares: CalendarShare[]): Promise<true | string> {
  const target = props.target
  if (!target) return Promise.resolve(t('This calendar no longer exists. Reload the page.'))
  return run(async () => {
    const saved = await api.saveShares(target.groupId, target.calendarId, toShareInput(shares))
    replaceCalendar(saved)
    return t('Sharing of {name} was saved.', { name: saved.name })
  }, N_('save the change'))
}

function askDelete() {
  deleteError.value = ''
  deleting.value = true
}

function closeDelete() {
  if (!busy.value) deleting.value = false
}

async function confirmDelete() {
  const target = props.target
  if (!target) return
  const message = t('{name} was deleted.', { name: calendar.value?.name ?? target.name })
  const answer = await run(async () => {
    await api.deleteCalendar(target.groupId, target.calendarId)
    return message
  }, N_('delete the calendar'))
  if (answer === true) {
    deleting.value = false
    emit('deleted', message)
    emit('close')
  } else {
    deleteError.value = answer
  }
}

function close() {
  // Not while a change is on its way: its answer belongs to this dialog.
  if (!busy.value) emit('close')
}
</script>
