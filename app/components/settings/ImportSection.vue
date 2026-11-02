<!--
  Importing an .ics file into one of the person's own calendars (FR-7, FR-9). The browser reads the
  file and splits it into events (utils/ical/split.ts, utils/import/), shows what it holds, and
  "Import" writes one resource per event through the session's CalDAV client; the app's own API is
  not involved. The file is untrusted: what is shown from it (name, titles) went through
  `displayText` and is only ever bound as text. Events already in the calendar are left alone.
  After events were written `calendar-sources-version` is bumped, which makes the calendar view
  load again. Not drawn in demo mode and wherever there is no calendar service to write to.
-->
<template>
  <section v-if="available" aria-labelledby="settings-import" class="flex flex-col gap-4">
    <h2 id="settings-import" ref="heading" tabindex="-1" class="text-lg font-semibold">
      {{ t('Import a calendar file') }}
    </h2>
    <p>
      <template
        v-for="(part, i) in tparts(
          'Add the events of an {ics} file to one of your calendars. The file is read in your browser. Events the calendar already has are left as they are, so importing a file twice does not make copies. To follow a calendar that keeps changing, add an iCal subscription instead.',
        )"
        :key="i"
      >
        <code v-if="'name' in part">.ics</code>
        <template v-else>{{ part.text }}</template>
      </template>
    </p>

    <div
      v-if="report"
      role="group"
      aria-labelledby="settings-import-result"
      class="flex flex-col gap-3 rounded-lg border border-default p-4"
    >
      <h3 id="settings-import-result" ref="resultHeading" tabindex="-1" class="font-semibold">
        {{ resultTitle }}
      </h3>
      <p>{{ summary }}</p>
      <SettingsErrorAlert v-if="report.stopped" :message="report.stopped" />
      <template v-if="problems.length > 0">
        <p class="font-medium">{{ t('Events that could not be imported') }}</p>
        <ul
          :aria-label="t('Events that could not be imported')"
          class="flex flex-col gap-1 text-sm"
        >
          <li v-for="(item, index) in shownProblems" :key="index" class="wrap-anywhere">
            <span class="font-medium">{{ item.title }}</span
            >: {{ item.message }}
          </li>
          <li v-if="problems.length > shownProblems.length" class="text-toned">
            {{ t('… and {count} more', { count: problems.length - shownProblems.length }) }}
          </li>
        </ul>
      </template>
      <p v-if="incomplete" class="text-sm text-toned">
        {{
          t(
            'You can import the file again: events that are already in the calendar are left alone.',
          )
        }}
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="incomplete"
          :label="t('Import again')"
          color="neutral"
          @click="importAgain"
        />
        <UButton :label="t('Done')" :color="incomplete ? 'neutral' : 'primary'" @click="finish" />
      </div>
    </div>

    <!-- Hidden, not removed, while the result is shown: "Import again" needs the chosen file. -->
    <div v-show="!report" class="flex flex-col gap-4">
      <UFormField
        :label="t('Calendar file')"
        name="import-file"
        :help="
          t('An .ics file of up to {size} and {max} events.', {
            size: formatBytes(MAX_FILE_BYTES),
            max: MAX_EVENTS,
          })
        "
        :error="fileError || undefined"
        :ui="FIELD_UI"
      >
        <!-- Announced when it appears; only given while there is an error, so there is no gap. -->
        <template v-if="fileError" #error="{ error }">
          <span role="alert">{{ error }}</span>
        </template>
        <UInput
          ref="fileInput"
          type="file"
          accept=".ics,.ical,.icalendar,.ifb,text/calendar"
          :disabled="importing"
          class="w-full"
          @change="onFile"
        />
      </UFormField>

      <div
        v-if="plan"
        class="flex flex-col gap-3 rounded-lg border border-default p-4"
        :aria-busy="importing"
      >
        <p class="font-semibold wrap-anywhere">{{ plan.preview.fileName }}</p>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <template v-if="plan.preview.calendarName">
            <dt class="text-toned">{{ t('Calendar name') }}</dt>
            <dd class="wrap-anywhere">{{ plan.preview.calendarName }}</dd>
          </template>
          <dt class="text-toned">{{ t('Events') }}</dt>
          <dd>{{ plan.preview.events }}</dd>
          <template v-if="plan.preview.skippedCount > 0">
            <dt class="text-toned">{{ t('Not imported') }}</dt>
            <dd>{{ plan.preview.skippedCount }}</dd>
          </template>
        </dl>
        <ul
          v-if="plan.preview.sample.length > 0"
          :aria-label="t('The first events in the file')"
          class="list-disc pl-5 text-sm"
        >
          <li v-for="(title, index) in plan.preview.sample" :key="index" class="wrap-anywhere">
            {{ title }}
          </li>
          <li v-if="plan.preview.events > plan.preview.sample.length" class="list-none text-toned">
            {{
              t('… and {count} more', {
                count: plan.preview.events - plan.preview.sample.length,
              })
            }}
          </li>
        </ul>
        <ul
          v-if="plan.preview.skipped.length > 0"
          :aria-label="t('What is not imported')"
          class="list-disc pl-5 text-sm"
        >
          <li v-for="group in plan.preview.skipped" :key="group.text">{{ group.text }}</li>
        </ul>

        <template v-if="plan.preview.events > 0">
          <p
            v-if="noWritableCalendar"
            class="rounded-lg border border-default bg-elevated p-3 text-sm"
          >
            {{
              t('None of your calendars can take new events. Ask for a calendar you can write to.')
            }}
          </p>
          <UFormField v-else :label="t('Import into')" name="import-calendar" required>
            <USelect
              v-model="calendarId"
              :items="calendarItems"
              :placeholder="t('Choose a calendar')"
              :disabled="importing"
              class="w-full"
              :ui="SELECT_UI"
            >
              <template #leading>
                <span
                  v-if="selectedCalendar"
                  class="size-3 rounded-full"
                  :style="{ backgroundColor: selectedCalendar.color }"
                  aria-hidden="true"
                />
              </template>
              <template #item-leading="{ item }">
                <span
                  class="size-3 shrink-0 rounded-full"
                  :style="{ backgroundColor: item.color }"
                  aria-hidden="true"
                />
              </template>
            </USelect>
          </UFormField>

          <div v-if="importing" class="flex flex-col gap-1">
            <progress
              :value="progress.done"
              :max="progress.total"
              :aria-label="t('Import progress')"
              class="h-2 w-full accent-(--ui-primary)"
            />
            <p class="text-sm text-toned" aria-hidden="true">
              {{ t('{done} of {total}', { done: progress.done, total: progress.total }) }}
            </p>
          </div>

          <div class="flex flex-wrap gap-2">
            <UButton
              ref="importButton"
              :label="
                importing
                  ? t('Importing…')
                  : tc('Import {count} event | Import {count} events', plan.preview.events)
              "
              icon="i-lucide-file-up"
              :disabled="!canImport"
              :aria-busy="importing"
              @click="startImport"
            />
            <UButton
              v-if="importing"
              ref="cancelButton"
              :label="t('Cancel import')"
              color="neutral"
              variant="outline"
              @click="cancelImport"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- Present from the start and only its text changes, so screen readers announce it. -->
    <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>
  </section>
</template>

<script setup lang="ts">
import { t, tc, tparts } from '~/utils/i18n'
import { useCalDav } from '~/composables/useCalDav'
import { useCalendarState } from '~/composables/useCalendarState'
import { useCalendarSourcesVersion, useLiveStatus } from '~/composables/useLiveCalendar'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { MAX_EVENTS, MAX_FILE_BYTES } from '~/utils/import/limits'
import { summarize } from '~/utils/import/messages'
import { prepareImport, type ImportPlan } from '~/utils/import/preview'
import { runImport, type ImportReport } from '~/utils/import/run'
import { isLiveConfig } from '~/utils/live/seed'
import { formatBytes } from '~/utils/settings/format'
import { FIELD_UI } from '~/utils/settings/ui'
import { writableCalendars } from '~/utils/writes/rules'

type Phase = 'empty' | 'ready' | 'importing' | 'done'

/** How many events that could not be imported are listed; the rest is counted. */
const MAX_LISTED = 100
const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }

const caldav = useCalDav()
const config = useServerConfigState()
const { calendars } = useCalendarState()
const { loading } = useLiveStatus()
// The calendar view reloads its sources when this changes (the live data loader watches it).
const sourcesVersion = useCalendarSourcesVersion()

// Importing writes to the calendar service: not in demo mode, nor where the plugin does not run.
const available = computed(() => isLiveConfig(config.value) && caldav !== null)

const heading = useTemplateRef<HTMLElement>('heading')
const resultHeading = useTemplateRef<HTMLElement>('resultHeading')
const fileInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('fileInput')
const importButton = useTemplateRef<{ $el: HTMLElement }>('importButton')
const cancelButton = useTemplateRef<{ $el: HTMLElement }>('cancelButton')

const phase = ref<Phase>('empty')
const plan = ref<ImportPlan | null>(null)
const report = ref<ImportReport | null>(null)
const fileError = ref('')
const notice = ref('')
const progress = reactive({ done: 0, total: 0 })
const importing = computed(() => phase.value === 'importing')

// ---- The calendar to import into ---------------------------------------------------------------

// The calendars the quick-add dialog offers: the ones the person may write to.
const choosable = computed(() => writableCalendars(calendars.value))
// Not while the calendars are still being loaded: the list is empty until they arrive.
const noWritableCalendar = computed(() => !loading.value && choosable.value.length === 0)
const calendarItems = computed(() =>
  choosable.value.map((calendar) => ({
    label: calendar.name,
    value: calendar.id,
    color: calendar.color,
  })),
)
const calendarId = ref('')
const selectedCalendar = computed(() =>
  choosable.value.find((calendar) => calendar.id === calendarId.value),
)
watch(
  choosable,
  (list) => {
    if (!list.some((calendar) => calendar.id === calendarId.value)) {
      calendarId.value = list[0]?.id ?? ''
    }
  },
  { immediate: true },
)

const canImport = computed(
  () =>
    phase.value === 'ready' &&
    (plan.value?.preview.events ?? 0) > 0 &&
    selectedCalendar.value !== undefined,
)

// ---- Choosing a file -----------------------------------------------------------------------------

// Counts the choices: the answer for a file that was replaced meanwhile is dropped.
let choice = 0

async function onFile(event: Event) {
  const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined
  const mine = ++choice
  plan.value = null
  phase.value = 'empty'
  fileError.value = ''
  notice.value = ''
  if (!file) return

  notice.value = t('Reading the file…')
  const result = await prepareImport(file)
  if (mine !== choice) return
  if (!result.ok) {
    fileError.value = result.message
    notice.value = ''
    return
  }
  plan.value = result.plan
  phase.value = 'ready'
  const count = result.plan.preview.events
  notice.value =
    count > 0
      ? tc(
          'File read: {count} event can be imported. | File read: {count} events can be imported.',
          count,
        )
      : t('File read: it has no events to import.')
}

// ---- Importing ------------------------------------------------------------------------------------

let controller: AbortController | null = null

async function startImport() {
  const current = plan.value
  const calendar = selectedCalendar.value
  if (!current || !calendar?.href || !caldav || phase.value !== 'ready') return
  const run = new AbortController()
  controller = run
  progress.done = 0
  progress.total = current.resources.length
  phase.value = 'importing'
  notice.value = tc('Importing {count} event… | Importing {count} events…', progress.total)
  // The button that was pressed is disabled now: the keyboard moves to the way out.
  await nextTick()
  cancelButton.value?.$el.focus()

  let result: ImportReport
  try {
    result = await runImport(caldav.client, {
      calendarHref: calendar.href,
      resources: current.resources,
      signal: run.signal,
      onProgress: (value) => {
        progress.done = value.done
      },
    })
  } catch {
    // Not a failure of one event (the run reports those): something in the run itself broke. The
    // person can try again; the section must not stay on "Importing" for ever.
    controller = null
    phase.value = 'ready'
    notice.value = t('The import could not be run. Try again.')
    return
  }
  controller = null
  report.value = result
  phase.value = 'done'
  notice.value = summarize(result)
  // Events that were interrupted or failed with an unclear answer may have been saved.
  if (result.created + result.interrupted + result.failed > 0) {
    caldav.reader.invalidate(calendar.href)
    sourcesVersion.value++
  }
  await nextTick()
  resultHeading.value?.focus()
}

function cancelImport() {
  notice.value = t('Cancelling…')
  controller?.abort()
}

onBeforeUnmount(() => controller?.abort())

// ---- The result -----------------------------------------------------------------------------------

const summary = computed(() => (report.value ? summarize(report.value) : ''))
const resultTitle = computed(() => {
  if (report.value?.cancelled) return t('Import cancelled')
  return report.value?.stopped ? t('Import stopped') : t('Import finished')
})
const problems = computed(
  () => report.value?.items.filter((item) => item.status === 'failed') ?? [],
)
const shownProblems = computed(() => problems.value.slice(0, MAX_LISTED))
// Something is left to do; running the file again does exactly that.
const incomplete = computed(
  () =>
    (report.value?.failed ?? 0) + (report.value?.notDone ?? 0) + (report.value?.interrupted ?? 0) >
    0,
)

async function importAgain() {
  report.value = null
  phase.value = 'ready'
  notice.value = ''
  await nextTick()
  importButton.value?.$el.focus()
}

async function finish() {
  report.value = null
  plan.value = null
  phase.value = 'empty'
  fileError.value = ''
  notice.value = ''
  const input = fileInput.value?.inputRef
  if (input) input.value = ''
  await nextTick()
  if (input) input.focus()
  else heading.value?.focus()
}
</script>
