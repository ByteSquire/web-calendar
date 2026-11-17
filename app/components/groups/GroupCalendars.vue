<!--
  The calendars a group owns. The group's managers and admins (`canManageCalendars`; the server
  decides again) get "New calendar" beside the heading, which opens a small dialog with the name and
  colour, and on each row "Edit" and "Share": Edit opens the dialog of a group calendar
  (CalendarDialog: name and colour, sharing, Delete after asking), the same one the sidebar opens,
  and Share the share dialog. Delete sits in that dialog rather than on the row, so a row keeps two
  buttons and stays one line on a phone. The other members see the list. A calendar's share list is
  shown as a sentence. What a change came to is a toast; a failure is a toast too and stays in the
  dialog where it happened. Each dialog starts afresh when it opens.
-->
<template>
  <section aria-labelledby="group-calendars-heading" class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2
        id="group-calendars-heading"
        ref="heading"
        tabindex="-1"
        class="text-lg font-semibold outline-none"
      >
        {{ t('Calendars') }}
      </h2>
      <UButton
        v-if="group.canManageCalendars"
        ref="newButton"
        :label="t('New calendar')"
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        aria-haspopup="dialog"
        @click="openCreate"
      />
    </div>
    <p class="text-sm text-toned">
      {{
        t(
          'Calendars of this group. Everybody in the group can use them; its managers create and share them, and the people and groups they share with can view or edit their events.',
        )
      }}
    </p>

    <p v-if="group.calendars.length === 0" class="text-toned" data-calendars-none>
      {{ t('This group has no calendars yet.') }}
    </p>
    <ul v-else :aria-label="t('Calendars')" class="flex flex-col gap-2">
      <li
        v-for="calendar in group.calendars"
        :key="calendar.id"
        data-group-calendar
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
      >
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
        <div v-if="group.canManageCalendars" class="flex flex-wrap gap-2">
          <UButton
            :aria-label="t('Edit {name}', { name: calendar.name })"
            icon="i-lucide-pencil"
            :label="t('Edit')"
            color="neutral"
            variant="outline"
            aria-haspopup="dialog"
            :disabled="busy"
            @click="openEdit(calendar)"
          />
          <UButton
            :aria-label="t('Share {name}', { name: calendar.name })"
            icon="i-lucide-share-2"
            :label="t('Share')"
            color="neutral"
            variant="outline"
            aria-haspopup="dialog"
            :disabled="busy"
            @click="openShare(calendar)"
          />
        </div>
      </li>
    </ul>

    <UModal
      :open="creating"
      :title="t('New calendar')"
      :description="t('A calendar of the group {group}.', { group: group.name })"
      :content="{ onOpenAutoFocus: focusCreateForm, onCloseAutoFocus: createFocus.restore }"
      :ui="{ description: 'wrap-anywhere' }"
      @update:open="(open) => (open ? undefined : closeCreate())"
    >
      <template #body>
        <GroupsCalendarForm
          ref="createForm"
          :busy="busy"
          cancellable
          hide-heading
          :save="create"
          @cancel="closeCreate"
        />
      </template>
    </UModal>

    <GroupsCalendarDialog
      :target="editing"
      :fallback="heading"
      @close="editing = null"
      @saved="(calendar) => emit('saved', calendar)"
      @deleted="onDeleted"
    />

    <GroupsCalendarShareDialog
      :open="sharing !== null"
      :calendar="sharingCalendar"
      :group-name="group.name"
      :groups="groups"
      :people="people"
      :people-truncated="peopleTruncated"
      :busy="busy"
      :save="saveShares"
      @update:open="(open) => (open ? undefined : (sharing = null))"
    />
  </section>
</template>

<script setup lang="ts">
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { t } from '~/utils/i18n'
import { createFocusReturn } from '~/utils/settings/focus-return'
import { colorName } from '~/utils/settings/palette'
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
  /** More people signed in than `people` holds (the server cuts the list). */
  peopleTruncated?: boolean
  busy: boolean
  /** Each returns true when it worked, else the words for the failure. */
  createCalendar: (body: CalendarFormBody) => Promise<true | string>
  shareCalendar: (calendar: GroupCalendar, shares: CalendarShare[]) => Promise<true | string>
}>()
const emit = defineEmits<{
  /** A calendar was changed in its dialog, as the server saved it. */
  saved: [calendar: GroupCalendar]
  /** A calendar was deleted in its dialog. */
  deleted: [calendarId: number]
}>()

const notify = useNotify()
const heading = useTemplateRef<HTMLElement>('heading')
const newButton = useTemplateRef<{ $el: HTMLElement }>('newButton')
const createForm = useTemplateRef<{ focusFirst: () => void }>('createForm')
const createFocus = createFocusReturn(() => newButton.value?.$el ?? heading.value)
const creating = ref(false)
const editing = ref<{ groupId: number; calendarId: number; name: string } | null>(null)
const sharing = ref<number | null>(null)

const sharingCalendar = computed(
  () => props.group.calendars.find((item) => item.id === sharing.value) ?? null,
)

function openCreate() {
  createFocus.remember()
  creating.value = true
}

function closeCreate() {
  if (!props.busy) creating.value = false
}

function focusCreateForm(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  createForm.value?.focusFirst()
}

async function create(body: CalendarFormBody): Promise<true | string> {
  const answer = await props.createCalendar(body)
  if (answer === true) {
    creating.value = false
    notify.done(t('{name} was added.', { name: body.name }))
  } else {
    notify.failed(answer)
  }
  return answer
}

function openEdit(calendar: GroupCalendar) {
  editing.value = { groupId: props.group.id, calendarId: calendar.id, name: calendar.name }
}

function onDeleted(message: string) {
  const id = editing.value?.calendarId
  notify.done(message)
  if (id !== undefined) emit('deleted', id)
}

function openShare(calendar: GroupCalendar) {
  sharing.value = calendar.id
}

async function saveShares(shares: CalendarShare[]): Promise<true | string> {
  const calendar = sharingCalendar.value
  if (!calendar) return t('This calendar no longer exists. Reload the page.')
  const answer = await props.shareCalendar(calendar, shares)
  if (answer === true) notify.done(t('Sharing of {name} was saved.', { name: calendar.name }))
  else notify.failed(answer)
  return answer
}
</script>
