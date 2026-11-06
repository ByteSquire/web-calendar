<!--
  "Turn into a status" for a category (the menu of its row in the sidebar): every event in the
  calendars the person can change that has the category gets a status (Confirmed, Tentative or
  Cancelled), which every calendar app shows, and by default loses the category. For people whose
  old system kept "Tentative" or "Confirmed" as a category. It first searches and says how many
  events it found, and changes nothing until "Change events" is pressed; then it rewrites them one
  by one (utils/writes/category-status.ts), says how far it is, and what came of it. Calendars the
  person can only read are not searched. The status is guessed from the name and can be changed.
-->
<template>
  <UModal
    :open="category !== null"
    :title="t('Turn {name} into a status', { name: shownName })"
    :description="
      t(
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
              v-model="status"
              :legend="t('Status')"
              :items="statusItems"
              :ui="{ item: 'min-h-11 items-center' }"
            />
            <UCheckbox
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
            {{ tc('{count} event was changed. | {count} events were changed.', result.changed) }}
          </p>
          <SettingsErrorAlert v-if="failureText" :message="failureText" />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="phase === 'done' || total === 0 ? t('Close') : t('Cancel')"
          color="neutral"
          variant="outline"
          :disabled="phase === 'working'"
          @click="close"
        />
        <UButton
          v-if="phase === 'ready' && total > 0"
          :label="tc('Change {count} event | Change {count} events', total)"
          icon="i-lucide-circle-check"
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
import { t, tc, tv } from '~/utils/i18n'
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

const props = defineProps<{ category: Category | null }>()
const emit = defineEmits<{ close: [] }>()

const caldav = useCalDav()
const status$ = useLiveStatus()
const { calendars, categories, selectedCategoryIds } = useCalendarState()
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

const failureText = computed(() => {
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
  if (!caldav || !category || phase.value !== 'ready') return
  phase.value = 'working'
  progress.value = 0
  result.value = await convertCategoryEvents(
    caldav.client,
    found.value,
    category.name,
    status.value,
    { removeCategory: removeCategory.value },
    context(),
    (done) => {
      progress.value = done
    },
  )
  phase.value = 'done'
  // The calendar shows the new statuses. A name that only events carried, taken from all of them,
  // leaves the list once they are read again (the list keeps such names while it can, so that one
  // that is selected does not vanish on the way to another week).
  await status$.refresh({ external: false })
  if (removeCategory.value && isAutoCategory(category) && result.value.failed.length === 0) {
    categories.value = categories.value.filter((item) => item.id !== category.id)
    selectedCategoryIds.value = selectedCategoryIds.value.filter((id) => id !== category.id)
  }
}

function close() {
  if (phase.value === 'working') return
  search?.abort()
  emit('close')
}
</script>
