<!--
  What a category means to the events that have it, from the menu of its row in the sidebar:
  - `status`, "Turn into a status": every event in the calendars the person can change that has
    the category gets a status (Confirmed, Tentative or Cancelled), which every calendar app shows,
    and by default loses the category. For people whose old system kept "Tentative" or "Confirmed"
    as a category. The status is guessed from the name and can be changed.
  - `delete`, "Delete": the category is taken off those events, and a saved category (its colour)
    is deleted too. Taking it off the events is what makes it go: the sidebar lists every name the
    events carry, so a category deleted alone came straight back as such a name.
  Both first search and say how many events they found, and change nothing until the button is
  pressed; then they rewrite them one by one (utils/writes/category-status.ts), say how far they
  are, and what came of it. Calendars the person can only read are not searched, so their events
  keep the name (and the list shows it for them).
-->
<template>
  <UModal
    :open="category !== null"
    :title="title"
    :description="
      mode === 'delete'
        ? t(
            'The category is taken off every event in your calendars that has it; their other categories and everything else stay. This cannot be undone.',
          )
        : t(
            'Every event in your calendars that has this category gets the status you choose. Other calendar apps show a status, unlike a category.',
          )
    "
    :ui="{ title: 'wrap-anywhere' }"
    @update:open="(open: boolean) => !open && close()"
  >
    <template #body>
      <div class="flex flex-col gap-4" :aria-busy="phase === 'searching' || phase === 'working'">
        <p v-if="phase === 'searching'" role="status">{{ t('Looking for the events…') }}</p>
        <SettingsErrorAlert v-for="line in searchProblems" :key="line" :message="line" />

        <template v-if="phase === 'ready'">
          <p v-if="total === 0" data-category-status-none>
            {{ t('No event in a calendar you can change has this category.') }}
            <template v-if="mode === 'delete' && saved">
              {{ t('Only the category itself is deleted.') }}
            </template>
          </p>
          <template v-else>
            <p data-category-status-found>
              {{
                tc('{count} event has this category. | {count} events have this category.', total)
              }}
              {{
                t('In: {calendars}.', {
                  calendars: found.map((entry) => entry.calendar.name).join(', '),
                })
              }}
            </p>
            <URadioGroup
              v-if="mode === 'status'"
              v-model="status"
              :legend="t('Status')"
              :items="statusItems"
              :ui="{ item: 'min-h-11 items-center' }"
            />
            <UCheckbox
              v-if="mode === 'status'"
              v-model="removeCategory"
              :label="t('Remove {name} from these events', { name: shownName })"
              :ui="{ root: 'min-h-11 items-center' }"
            />
          </template>
        </template>

        <p v-if="phase === 'working'" role="status" aria-live="polite">
          {{ t('Changing the events: {done} of {total}', { done: progress, total }) }}
        </p>
        <div v-if="phase === 'done'" role="status" class="flex flex-col gap-2">
          <p data-category-status-done>
            <template v-if="mode === 'delete' && total === 0">
              {{ t('The category was deleted.') }}
            </template>
            <template v-else>
              {{ tc('{count} event was changed. | {count} events were changed.', result.changed) }}
            </template>
          </p>
          <SettingsErrorAlert v-if="failureText" :message="failureText" />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="phase === 'done' || (total === 0 && !canRun) ? t('Close') : t('Cancel')"
          color="neutral"
          variant="outline"
          :disabled="phase === 'working'"
          @click="close"
        />
        <UButton
          v-if="phase === 'ready' && canRun"
          :label="runLabel"
          :icon="mode === 'delete' ? 'i-lucide-trash-2' : 'i-lucide-circle-check'"
          :color="mode === 'delete' ? 'error' : 'primary'"
          @click="run"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { Category } from '../../shared/types/calendar'
import { useCalDav } from '~/composables/useCalDav'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { STATUS_LABELS } from '~/utils/event-display'
import { N_, t, tc, tv } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'
import type { EventStatusValue } from '~/utils/ical/write-types'
import { isAutoCategory } from '~/utils/live/categories'
import { describeLoadError } from '~/utils/live/errors'
import { describeWriteError } from '~/utils/writes/messages'
import {
  convertCategoryEvents,
  findCategoryEvents,
  type CategoryStatusResult,
  type FoundInCalendar,
} from '~/utils/writes/category-status'

const props = withDefaults(
  defineProps<{ category: Category | null; mode?: 'status' | 'delete' }>(),
  { mode: 'status' },
)
const emit = defineEmits<{ close: [] }>()

const caldav = useCalDav()
const status$ = useLiveStatus()
const { calendars, categories, selectedCategoryIds, deleteCategory } = useCalendarState()
const displayTimeZone = useDisplayTimeZone()
const orgTimeZone = useOrgTimeZone()

type Phase = 'searching' | 'ready' | 'working' | 'done'
const phase = ref<Phase>('searching')
const found = ref<FoundInCalendar[]>([])
const searchProblems = ref<string[]>([])
const status = ref<EventStatusValue>('confirmed')
const removeCategory = ref(true)
const progress = ref(0)
const result = ref<CategoryStatusResult>({ changed: 0, unchanged: 0, failed: [] })
// Kept while the dialog closes, so the title does not flash empty.
const shownName = ref('')
let search: AbortController | null = null

const total = computed(() => found.value.reduce((sum, entry) => sum + entry.objects.length, 0))
const title = computed(() =>
  props.mode === 'delete'
    ? t('Delete "{title}"?', { title: shownName.value })
    : t('Turn {name} into a status', { name: shownName.value }),
)
/** A category with a saved row (its colour); one that only events carry has none. */
const saved = computed(() => props.category !== null && !isAutoCategory(props.category))
/** There is something to do: events to change, or a saved category to delete. */
const canRun = computed(() => total.value > 0 || (props.mode === 'delete' && saved.value))
const runLabel = computed(() => {
  if (props.mode === 'status') {
    return tc('Change {count} event | Change {count} events', total.value)
  }
  return total.value > 0
    ? tc('Delete from {count} event | Delete from {count} events', total.value)
    : t('Delete')
})
const statusItems = computed(() =>
  (['confirmed', 'tentative', 'cancelled'] as const).map((value) => ({
    value,
    label: tv(STATUS_LABELS[value]),
  })),
)

/** The status a category's name says, in English or German; Confirmed when it says none. */
function guessStatus(name: string): EventStatusValue {
  const key = name.trim().toLowerCase()
  if (/^(tentative|provisional|maybe|vorläufig|vorlaeufig|unsicher|vielleicht)$/.test(key)) {
    return 'tentative'
  }
  if (/^(cancell?ed|abgesagt|storniert|entfällt|entfaellt)$/.test(key)) return 'cancelled'
  return 'confirmed'
}

const context = () => ({
  displayTimeZone: displayTimeZone.value,
  orgTimeZone: orgTimeZone.value,
})

watch(
  () => props.category,
  (category) => {
    if (!category) return
    shownName.value = category.name
    status.value = guessStatus(category.name)
    removeCategory.value = true
    void start(category.name)
  },
  { immediate: true },
)

async function start(name: string) {
  search?.abort()
  search = new AbortController()
  const signal = search.signal
  phase.value = 'searching'
  found.value = []
  searchProblems.value = []
  if (!caldav) {
    phase.value = 'ready'
    return
  }
  try {
    const answer = await findCategoryEvents(caldav.client, calendars.value, name, context(), signal)
    if (signal.aborted) return
    found.value = answer.found
    searchProblems.value = answer.failed.map(({ calendar, error }) =>
      t('{calendar} could not be searched: {problem}', {
        calendar: calendar.name,
        problem: describeLoadError(error),
      }),
    )
  } catch (error) {
    if (signal.aborted) return
    searchProblems.value = [describeLoadError(error)]
  }
  phase.value = 'ready'
}

const deleteProblem = ref('')
const failureText = computed(() => {
  if (deleteProblem.value) return deleteProblem.value
  const failed = result.value.failed
  if (failed.length === 0) return ''
  return tc(
    '{count} event could not be changed: {reason} | {count} events could not be changed. The first: {reason}',
    failed.length,
    { reason: describeWriteError(failed[0]!.error, 'edit').message },
  )
})

async function run() {
  const category = props.category
  if (!caldav || !category || phase.value !== 'ready' || !canRun.value) return
  const deleting = props.mode === 'delete'
  const takenOff = deleting || removeCategory.value
  phase.value = 'working'
  progress.value = 0
  deleteProblem.value = ''
  result.value = await convertCategoryEvents(
    caldav.client,
    found.value,
    category.name,
    deleting ? null : status.value,
    { removeCategory: takenOff },
    context(),
    (done) => {
      progress.value = done
    },
  )
  const complete = result.value.failed.length === 0
  // The saved category goes once no event has it any more; while some still do, it stays, with
  // its colour, and the dialog says why.
  if (deleting && saved.value && complete) {
    try {
      await deleteCategory(category.id)
    } catch (cause) {
      deleteProblem.value = describeError(cause, N_('delete the category'))
    }
  }
  phase.value = 'done'
  // The calendar shows the change. A name that only events carried, taken from all of them,
  // leaves the list once they are read again (the list keeps such names while it can, so that one
  // that is selected does not vanish on the way to another week).
  await status$.refresh({ external: false })
  if (takenOff && complete) {
    categories.value = categories.value.filter(
      (item) => item.id !== category.id && !(isAutoCategory(item) && sameName(item, category)),
    )
    selectedCategoryIds.value = selectedCategoryIds.value.filter((id) =>
      categories.value.some((item) => item.id === id),
    )
  }
}

const sameName = (a: Category, b: Category) =>
  a.name.trim().toLowerCase() === b.name.trim().toLowerCase()

function close() {
  if (phase.value === 'working') return
  search?.abort()
  emit('close')
}
</script>
