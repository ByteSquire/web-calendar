<!--
  The calendars a group owns: create one, rename it, change its colour, share it and delete it.
  Everybody who sees the group may do these (the server decides for members and admins alike); a
  calendar's share list is shown as a sentence, and the dialog changes it. Deleting asks first
  (SettingsConfirmModal), since the calendar, its events and its shares go with it. Each action
  returns true when it worked, else the words for the failure, which are shown here.
-->
<template>
  <section aria-labelledby="group-calendars-heading" class="flex flex-col gap-4">
    <h3
      id="group-calendars-heading"
      ref="heading"
      tabindex="-1"
      class="text-lg font-semibold outline-none"
    >
      {{ t('Calendars') }}
    </h3>
    <p class="text-sm text-toned">
      {{
        t(
          'Calendars of this group. Everybody in the group can create and share them; the people and groups you share with can view or edit their events.',
        )
      }}
    </p>

    <SettingsErrorAlert v-if="alert" :message="alert" />
    <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>

    <p v-if="group.calendars.length === 0" class="text-toned" data-calendars-none>
      {{ t('This group has no calendars yet.') }}
    </p>
    <ul v-else :aria-label="t('Calendars')" class="flex flex-col gap-2">
      <li
        v-for="calendar in group.calendars"
        :key="calendar.id"
        data-group-calendar
        class="flex flex-col gap-3 rounded-md border border-default p-3"
      >
        <GroupsCalendarForm
          v-if="renaming === calendar.id"
          :key="`edit-${calendar.id}`"
          :initial="calendar"
          :busy="busy"
          cancellable
          :save="(body) => rename(calendar, body)"
          @cancel="renaming = null"
        />
        <template v-else>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span
              class="size-5 shrink-0 rounded-full ring-1 ring-black/40 dark:ring-white/60"
              :class="calendar.color ? '' : 'border border-dashed border-accented bg-default'"
              :style="calendar.color ? { backgroundColor: calendar.color } : undefined"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1 basis-48">
              <p class="font-medium wrap-anywhere">{{ calendar.name }}</p>
              <p class="text-sm text-toned wrap-anywhere">
                {{ colorName(calendar.color) }} ·
                {{ shareSummary(calendar.shares, group.name) }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton
                :aria-label="t('Edit {name}', { name: calendar.name })"
                icon="i-lucide-pencil"
                :label="t('Edit')"
                color="neutral"
                variant="outline"
                :disabled="busy"
                @click="startRename(calendar)"
              />
              <UButton
                :aria-label="t('Share {name}', { name: calendar.name })"
                icon="i-lucide-share-2"
                :label="t('Share')"
                color="neutral"
                variant="outline"
                :disabled="busy"
                @click="openShare(calendar)"
              />
              <UButton
                :aria-label="t('Delete {name}', { name: calendar.name })"
                icon="i-lucide-trash-2"
                :label="t('Delete')"
                color="neutral"
                variant="outline"
                :disabled="busy"
                @click="askDelete(calendar)"
              />
            </div>
          </div>
        </template>
      </li>
    </ul>

    <div class="rounded-lg border border-default p-4">
      <GroupsCalendarForm :busy="busy" :save="create" />
    </div>

    <GroupsCalendarShareDialog
      :open="sharing !== null"
      :calendar="sharingCalendar"
      :group-name="group.name"
      :groups="groups"
      :people="people"
      :busy="busy"
      :save="saveShares"
      @update:open="(open) => (open ? undefined : (sharing = null))"
    />

    <SettingsConfirmModal
      :open="deleting !== null"
      :title="t('Delete {name}?', { name: deleting?.name ?? '' })"
      :description="
        t('The calendar, its events and its sharing are deleted. This cannot be undone.')
      "
      :confirm-label="t('Delete')"
      :busy="busy"
      :error="deleteError"
      :fallback="heading"
      @update:open="(open) => (open ? undefined : closeDelete())"
      @confirm="confirmDelete"
    />
  </section>
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'
import { colorName } from '~/utils/settings/palette'
import type { CalendarBody } from '~/composables/useGroups'
import type {
  CalendarShare,
  GroupCalendar,
  GroupDetail,
  GroupPerson,
  GroupSummary,
} from '~/utils/groups/model'
import { shareSummary } from '~/utils/groups/shares'
import type { CalendarFormBody } from './CalendarForm.vue'

const props = defineProps<{
  group: GroupDetail
  groups: readonly GroupSummary[]
  people: readonly GroupPerson[]
  busy: boolean
  /** Each returns true when it worked, else the words for the failure. */
  createCalendar: (body: CalendarFormBody) => Promise<true | string>
  updateCalendar: (calendar: GroupCalendar, body: CalendarBody) => Promise<true | string>
  deleteCalendar: (calendar: GroupCalendar) => Promise<true | string>
  shareCalendar: (calendar: GroupCalendar, shares: CalendarShare[]) => Promise<true | string>
}>()

const heading = useTemplateRef<HTMLElement>('heading')
const alert = ref<string | undefined>(undefined)
const notice = ref('')
const renaming = ref<number | null>(null)
const sharing = ref<number | null>(null)
const deleting = ref<GroupCalendar | null>(null)
const deleteError = ref<string | null>(null)

const sharingCalendar = computed(
  () => props.group.calendars.find((item) => item.id === sharing.value) ?? null,
)

function startRename(calendar: GroupCalendar) {
  alert.value = undefined
  renaming.value = calendar.id
}

async function create(body: CalendarFormBody): Promise<true | string> {
  alert.value = undefined
  const answer = await props.createCalendar(body)
  if (answer === true) notice.value = t('{name} was added.', { name: body.name })
  return answer
}

async function rename(calendar: GroupCalendar, body: CalendarFormBody): Promise<true | string> {
  const answer = await props.updateCalendar(calendar, body)
  if (answer !== true) return answer
  renaming.value = null
  notice.value = t('{name} was saved.', { name: body.name })
  return true
}

function openShare(calendar: GroupCalendar) {
  alert.value = undefined
  sharing.value = calendar.id
}

async function saveShares(shares: CalendarShare[]): Promise<true | string> {
  const calendar = sharingCalendar.value
  if (!calendar) return t('This calendar no longer exists. Reload the page.')
  const answer = await props.shareCalendar(calendar, shares)
  if (answer === true) notice.value = t('Sharing of {name} was saved.', { name: calendar.name })
  return answer
}

function askDelete(calendar: GroupCalendar) {
  alert.value = undefined
  deleteError.value = null
  deleting.value = calendar
}

function closeDelete() {
  if (props.busy) return
  deleting.value = null
}

async function confirmDelete() {
  const calendar = deleting.value
  if (!calendar) return
  deleteError.value = null
  const answer = await props.deleteCalendar(calendar)
  if (answer === true) {
    deleting.value = null
    notice.value = t('{name} was deleted.', { name: calendar.name })
  } else {
    deleteError.value = answer
  }
}
</script>
