<!--
  Importing an .ics file into one of the person's own calendars (FR-7, FR-9). The section holds the
  explanation and "Choose file…", which opens the browser's file picker (a native file input,
  hidden: the button is the way to it). The chosen file opens one dialog for the whole job: the
  browser reads the file and splits it into events (utils/ical/split.ts, utils/import/) and the
  dialog shows what it holds, the calendar to import into, the progress and then the result (with
  "Import again" while something is left to do). "Import" writes one resource per event through the
  session's CalDAV client; the app's own API is not involved. The file is untrusted: what is shown
  from it (name, titles) went through `displayText` and is only ever bound as text. Events already
  in the calendar are left alone. The person may choose "New calendar…" instead of one of theirs:
  the calendar is then made (MKCALENDAR in their home) when Import is pressed. A running import can
  be cancelled ("Cancel import") but the dialog cannot be closed meanwhile; closing it afterwards
  puts everything back as it was, with the file input emptied. A failed run is told in the dialog
  and in a toast. After events were written `calendar-sources-version` is bumped, which makes the
  calendar view load again. Not drawn in demo mode and wherever there is no calendar service to
  write to.
-->
<template>
  <section v-if="available" aria-labelledby="settings-import" class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 id="settings-import" ref="heading" tabindex="-1" class="text-lg font-semibold">
        {{ t('Import a calendar file') }}
      </h2>
      <UButton
        ref="chooseButton"
        :label="t('Choose file…')"
        icon="i-lucide-file-up"
        aria-haspopup="dialog"
        aria-describedby="settings-import-limits"
        @click="chooseFile"
      />
    </div>
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
    <p id="settings-import-limits" class="text-sm text-toned">
      {{
        t('An .ics file of up to {size} and {max} events.', {
          size: formatBytes(MAX_FILE_BYTES),
          max: MAX_EVENTS,
        })
      }}
    </p>
    <!-- "Choose file…" is the way to it; the input itself is out of sight and out of the tab order. -->
    <input
      ref="fileInput"
      type="file"
      accept=".ics,.ical,.icalendar,.ifb,text/calendar"
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      :aria-label="t('Calendar file')"
      @change="onFile"
    />

    <UModal
      :open="dialogOpen"
      :title="t('Import a calendar file')"
      :description="t('See what the file holds, then choose the calendar for its events.')"
      :content="{ onOpenAutoFocus: focusOnOpen, onCloseAutoFocus: dialogFocus.restore }"
      :ui="{ title: 'wrap-anywhere', description: 'wrap-anywhere' }"
      @update:open="(open: boolean) => !open && closeDialog()"
    >
      <template #body>
        <div class="flex flex-col gap-3" :aria-busy="busy || phase === 'reading'">
          <SettingsErrorAlert v-if="fileError" :message="fileError" />

          <div
            v-if="report"
            role="group"
            aria-labelledby="settings-import-result"
            class="flex flex-col gap-3"
          >
            <h3 id="settings-import-result" ref="resultHeading" tabindex="-1" class="font-semibold">
              {{ resultTitle }}
            </h3>
            <p v-if="createdTarget">
              {{ t('The calendar “{name}” was created.', { name: createdTarget.name }) }}
            </p>
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
          </div>

          <template v-else-if="plan">
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
              <li
                v-if="plan.preview.events > plan.preview.sample.length"
                class="list-none text-toned"
              >
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
              <UFormField :label="t('Import into')" name="import-calendar" required>
                <USelect
                  v-model="calendarId"
                  :items="calendarItems"
                  :placeholder="t('Choose a calendar')"
                  :disabled="busy || createdTarget !== null"
                  class="w-full"
                  :ui="SELECT_UI"
                >
                  <template #leading>
                    <UIcon
                      v-if="calendarId === NEW_CALENDAR"
                      name="i-lucide-plus"
                      class="size-4"
                      aria-hidden="true"
                    />
                    <span
                      v-else-if="selectedCalendar"
                      class="size-3 rounded-full"
                      :style="{ backgroundColor: selectedCalendar.color }"
                      aria-hidden="true"
                    />
                  </template>
                  <template #item-leading="{ item }">
                    <UIcon
                      v-if="item.value === NEW_CALENDAR"
                      name="i-lucide-plus"
                      class="size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span
                      v-else
                      class="size-3 shrink-0 rounded-full"
                      :style="{ backgroundColor: item.color }"
                      aria-hidden="true"
                    />
                  </template>
                </USelect>
              </UFormField>
              <!-- A new calendar is made in the person's own home when "Import" is pressed. -->
              <UFormField
                v-if="calendarId === NEW_CALENDAR"
                :label="t('Name of the new calendar')"
                name="import-new-calendar"
                :error="newNameError || undefined"
                :ui="FIELD_UI"
                required
              >
                <template v-if="newNameError" #error="{ error }">
                  <span role="alert">{{ error }}</span>
                </template>
                <UInput
                  v-model="newName"
                  :maxlength="CALENDAR_NAME_MAX"
                  autocomplete="off"
                  :disabled="busy || createdTarget !== null"
                  class="w-full"
                />
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
            </template>
          </template>

          <!-- Present from the start and only its text changes, so screen readers announce it. -->
          <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <template v-if="report">
            <UButton
              v-if="incomplete"
              :label="t('Import again')"
              color="neutral"
              variant="outline"
              @click="importAgain"
            />
            <UButton
              :label="t('Done')"
              :color="incomplete ? 'neutral' : 'primary'"
              @click="closeDialog"
            />
          </template>
          <template v-else>
            <UButton
              v-if="fileError"
              :label="t('Choose another file…')"
              icon="i-lucide-file-up"
              color="neutral"
              variant="outline"
              @click="chooseFile"
            />
            <UButton
              v-if="importing"
              ref="cancelButton"
              :label="t('Cancel import')"
              color="neutral"
              variant="outline"
              @click="cancelImport"
            />
            <UButton
              v-else
              ref="closeButton"
              :label="t('Cancel')"
              color="neutral"
              variant="outline"
              :disabled="creating"
              @click="closeDialog"
            />
            <UButton
              v-if="canOffer && plan"
              ref="importButton"
              :label="
                creating
                  ? t('Creating the calendar…')
                  : importing
                    ? t('Importing…')
                    : tc('Import {count} event | Import {count} events', plan.preview.events)
              "
              icon="i-lucide-file-up"
              :disabled="!canImport"
              :aria-busy="busy"
              @click="startImport"
            />
          </template>
        </div>
      </template>
    </UModal>
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
import { calendarNameProblem, GROUP_LIMITS } from '~/utils/groups/model'
import { describeLoadError } from '~/utils/live/errors'
import { isLiveConfig } from '~/utils/live/seed'
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { createFocusReturn } from '~/utils/settings/focus-return'
import { formatBytes } from '~/utils/settings/format'
import { FIELD_UI } from '~/utils/settings/ui'
import { toDavPath } from '~/utils/caldav/urls'
import { writableCalendars } from '~/utils/writes/rules'

type Phase = 'empty' | 'reading' | 'ready' | 'importing' | 'done'

/** How many events that could not be imported are listed; the rest is counted. */
const MAX_LISTED = 100
const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }
/** The choice that makes a calendar for the file instead of using one of the person's. */
const NEW_CALENDAR = '__new_calendar__'
const CALENDAR_NAME_MAX = GROUP_LIMITS.calendarName

const caldav = useCalDav()
const notify = useNotify()
const config = useServerConfigState()
const { calendars } = useCalendarState()
const { loading } = useLiveStatus()
// The calendar view reloads its sources when this changes (the live data loader watches it).
const sourcesVersion = useCalendarSourcesVersion()

// Importing writes to the calendar service: not in demo mode, nor where the plugin does not run.
const available = computed(() => isLiveConfig(config.value) && caldav !== null)

const heading = useTemplateRef<HTMLElement>('heading')
const chooseButton = useTemplateRef<{ $el: HTMLElement }>('chooseButton')
const resultHeading = useTemplateRef<HTMLElement>('resultHeading')
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const importButton = useTemplateRef<{ $el: HTMLElement }>('importButton')
const cancelButton = useTemplateRef<{ $el: HTMLElement }>('cancelButton')
const closeButton = useTemplateRef<{ $el: HTMLElement }>('closeButton')

const phase = ref<Phase>('empty')
const plan = ref<ImportPlan | null>(null)
const report = ref<ImportReport | null>(null)
const fileError = ref('')
const notice = ref('')
const progress = reactive({ done: 0, total: 0 })
const importing = computed(() => phase.value === 'importing')
const creating = ref(false)
// Making the calendar and filling it are one job for the controls.
const busy = computed(() => importing.value || creating.value)

const dialogOpen = ref(false)
const dialogFocus = createFocusReturn(() => chooseButton.value?.$el ?? heading.value)

// ---- The calendar to import into ---------------------------------------------------------------

// The calendars the quick-add dialog offers: the ones the person may write to.
const choosable = computed(() => writableCalendars(calendars.value))
const calendarItems = computed(() => [
  ...choosable.value.map((calendar) => ({
    label: calendar.name,
    value: calendar.id,
    color: calendar.color,
  })),
  { label: t('New calendar…'), value: NEW_CALENDAR, color: '' },
])
const calendarId = ref('')
const selectedCalendar = computed(() =>
  choosable.value.find((calendar) => calendar.id === calendarId.value),
)
// The first calendar the person can write to; with none (and the list loaded) a new one. That "new"
// was not their choice, so it gives way when calendars arrive after all.
let newByDefault = false
watch(
  [choosable, loading],
  ([list, isLoading]) => {
    if (calendarId.value === NEW_CALENDAR && !(newByDefault && list.length > 0)) return
    if (!list.some((calendar) => calendar.id === calendarId.value)) {
      const first = list[0]?.id
      calendarId.value = first ?? (isLoading ? '' : NEW_CALENDAR)
      newByDefault = first === undefined && !isLoading
    }
  },
  { immediate: true },
)

// The name of a calendar that is made for the file; it starts as the file's own calendar name.
const newName = ref('')
const newNameError = ref('')
watch(newName, () => (newNameError.value = ''))
/** The calendar this run made, so that "Import again" fills it instead of making another. */
const createdTarget = ref<{ href: string; name: string } | null>(null)

/** The file has events to import: the dialog offers Import. */
const canOffer = computed(() => !fileError.value && (plan.value?.preview.events ?? 0) > 0)

const canImport = computed(
  () =>
    phase.value === 'ready' &&
    (plan.value?.preview.events ?? 0) > 0 &&
    (selectedCalendar.value !== undefined || calendarId.value === NEW_CALENDAR),
)

// ---- Choosing a file -----------------------------------------------------------------------------

// Counts the choices: the answer for a file that was replaced meanwhile is dropped.
let choice = 0

/** Opens the browser's file picker; the input is emptied first, so the same file counts again. */
function chooseFile() {
  const input = fileInput.value
  if (!input || busy.value) return
  input.value = ''
  input.click()
}

async function onFile(event: Event) {
  const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined
  // The picker was closed without a file: nothing changes.
  if (!file || busy.value) return
  const mine = ++choice
  if (!dialogOpen.value) {
    dialogFocus.remember()
    dialogOpen.value = true
  }
  report.value = null
  plan.value = null
  phase.value = 'reading'
  fileError.value = ''
  createdTarget.value = null
  newNameError.value = ''
  notice.value = t('Reading the file…')

  const result = await prepareImport(file)
  if (mine !== choice || !dialogOpen.value) return
  if (!result.ok) {
    phase.value = 'empty'
    fileError.value = result.message
    notice.value = ''
    await nextTick()
    closeButton.value?.$el.focus()
    return
  }
  plan.value = result.plan
  phase.value = 'ready'
  newName.value = (result.plan.preview.calendarName || stem(result.plan.preview.fileName)).slice(
    0,
    CALENDAR_NAME_MAX,
  )
  const count = result.plan.preview.events
  notice.value =
    count > 0
      ? tc(
          'File read: {count} event can be imported. | File read: {count} events can be imported.',
          count,
        )
      : t('File read: it has no events to import.')
  await nextTick()
  ;(importButton.value ?? closeButton.value)?.$el.focus()
}

/** Into the dialog: Import when the file is read already, else Cancel. */
function focusOnOpen(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  ;(importButton.value ?? closeButton.value)?.$el.focus()
}

/** Back to the start: no file, no preview, no result. Not while a run cannot be stopped. */
function closeDialog() {
  if (busy.value) return
  choice++
  dialogOpen.value = false
  report.value = null
  plan.value = null
  phase.value = 'empty'
  fileError.value = ''
  notice.value = ''
  createdTarget.value = null
  newNameError.value = ''
  const first = choosable.value[0]?.id
  calendarId.value = first ?? NEW_CALENDAR
  newByDefault = first === undefined
  if (fileInput.value) fileInput.value.value = ''
}

// ---- Importing ------------------------------------------------------------------------------------

let controller: AbortController | null = null

/** A file name without its extension, for the name of a new calendar. */
function stem(fileName: string): string {
  return fileName.replace(/\.(ics|ical|icalendar|ifb)$/i, '')
}

/**
 * The href to write to: the chosen calendar's, or a new calendar's (made now, in the person's own
 * home). Null when there is nothing to write to yet; the reason is then shown where it belongs.
 */
async function targetHref(): Promise<string | null> {
  if (calendarId.value !== NEW_CALENDAR) return selectedCalendar.value?.href ?? null
  if (createdTarget.value) return createdTarget.value.href
  const problem = calendarNameProblem(newName.value)
  if (problem) {
    newNameError.value = problem
    return null
  }
  if (!caldav) return null
  creating.value = true
  notice.value = t('Creating the calendar…')
  try {
    const made = await caldav.client.createCalendar({ displayName: newName.value.trim() })
    createdTarget.value = { href: toDavPath(made.url), name: made.displayName }
    // The calendar is there from now on, whatever the import does: the sidebar lists it.
    sourcesVersion.value++
    return createdTarget.value.href
  } catch (error) {
    newNameError.value = t('The calendar could not be created: {problem}', {
      problem: describeLoadError(error),
    })
    notify.failed(newNameError.value)
    notice.value = ''
    return null
  } finally {
    creating.value = false
  }
}

async function startImport() {
  const current = plan.value
  if (!current || !caldav || phase.value !== 'ready' || creating.value) return
  const calendarHref = await targetHref()
  if (!calendarHref) return
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
      calendarHref,
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
    notify.failed(notice.value)
    return
  }
  controller = null
  report.value = result
  phase.value = 'done'
  notice.value = summarize(result)
  if (result.stopped) notify.failed(result.stopped)
  // Events that were interrupted or failed with an unclear answer may have been saved.
  if (result.created + result.interrupted + result.failed > 0) {
    caldav.reader.invalidate(calendarHref)
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
</script>
