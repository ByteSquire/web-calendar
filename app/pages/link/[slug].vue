<!--
  The page of a calendar link: a visitor without an account enters the password and sees that one
  calendar, read-only. No sidebar, no adding or editing; the top bar keeps the date navigation and
  the view types, and its menu only the look of the page (dark mode, language, full screen). The
  session lasts 8 hours and is kept for this tab only (sessionStorage); after that, or when the link
  was withdrawn, the page says so. The calendar view, the top bar and the event sheet are the app's
  own, made read-only by `useCalendarLinkView()`.
-->
<template>
  <div v-if="opened" class="app-shell link-view">
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-default focus:px-3 focus:py-2 focus:ring-2 focus:ring-primary"
      >{{ t('Skip to main content') }}</a
    >
    <TopBar />
    <main id="main-content" tabindex="-1" class="main-area focus:outline-none" :aria-busy="loading">
      <UAlert
        v-if="readProblem"
        class="m-2"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="readProblem"
      />
      <SplitView v-if="viewType === 'split'" />
      <CalendarMain v-else />
    </main>
    <EventSheet />
  </div>

  <main
    v-else
    id="main-content"
    class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6"
  >
    <header class="flex flex-col gap-2">
      <UIcon name="i-lucide-lock" class="size-8 text-primary" aria-hidden="true" />
      <h1 class="text-2xl font-semibold">{{ t('A shared calendar') }}</h1>
      <p class="text-toned">{{ t('Enter the password you were given to see this calendar.') }}</p>
    </header>
    <UAlert
      v-if="failure"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="failure"
      role="alert"
    />
    <form v-if="!gone" novalidate class="flex flex-col gap-4" @submit.prevent="submit">
      <UFormField :label="t('Password')" name="link-password" required>
        <UInput
          ref="passwordInput"
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="w-full"
          :readonly="busy"
        />
      </UFormField>
      <div>
        <UButton
          type="submit"
          :label="t('Open calendar')"
          icon="i-lucide-lock-open"
          :loading="busy"
          :disabled="password.length === 0"
        />
      </div>
    </form>
  </main>
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'
import {
  LINK_CALENDAR_ID,
  failureOf,
  fetchLinkObjects,
  linkEvents,
  openLink,
  readStoredSession,
  storeSession,
  type LinkFailure,
  type LinkSession,
} from '~/utils/links/page'
import { loadRange, rangeKey } from '~/utils/live/range'

definePageMeta({ layout: false })

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
const linkView = useCalendarLinkView()
useHead({
  title: () => linkView.value?.name ?? t('A shared calendar'),
  // The address is the key to the calendar: no search engine, no referrer to other sites.
  meta: [
    { name: 'robots', content: 'noindex, nofollow' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})
const state = useCalendarState()
const { viewType, visibleRange } = state
const displayTimeZone = useDisplayTimeZone()
const orgTimeZone = useOrgTimeZone()

const session = ref<LinkSession | null>(null)
const opened = computed(() => session.value !== null)
const password = ref('')
const busy = ref(false)
const failureKind = ref<LinkFailure | null>(null)
const loading = ref(false)
const readProblem = ref<string | null>(null)
const passwordInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('passwordInput')

const FAILURES: Record<LinkFailure, () => string> = {
  wrong_password: () => t('The password is not right.'),
  unavailable: () => t('This link does not exist, was withdrawn or does not work at the moment.'),
  session: () => t('Enter the password again.'),
  too_many: () => t('Too many tries. Wait a minute and try again.'),
  other: () => t('The calendar could not be opened. Try again.'),
}
const failure = computed(() => (failureKind.value ? FAILURES[failureKind.value]() : null))
const gone = computed(() => failureKind.value === 'unavailable')

/** The calendar of the link is the only one in the view. */
function show(next: LinkSession) {
  session.value = next
  linkView.value = next.calendar
  state.calendars.value = [
    {
      id: LINK_CALENDAR_ID,
      name: next.calendar.name,
      type: 'caldav',
      color: next.calendar.color ?? '#2563eb',
      defaultVisible: true,
      readOnly: true,
    },
  ]
  state.visibleCalendarIds.value = [LINK_CALENDAR_ID]
  state.views.value = []
  state.categories.value = []
  state.filters.value = []
  state.events.value = []
  state.sidebarOpen.value = false
}

function close(kind: LinkFailure) {
  storeSession(slug.value, null)
  session.value = null
  linkView.value = null
  failureKind.value = kind
  void nextTick(() => passwordInput.value?.inputRef?.focus())
}

async function submit() {
  if (busy.value || password.value.length === 0) return
  busy.value = true
  failureKind.value = null
  try {
    const next = await openLink(slug.value, password.value)
    password.value = ''
    storeSession(slug.value, next)
    show(next)
  } catch (error) {
    failureKind.value = failureOf(error)
    await nextTick()
    passwordInput.value?.inputRef?.focus()
  } finally {
    busy.value = false
  }
}

let loadCount = 0
async function load() {
  const current = session.value
  if (!current) return
  const range = loadRange(visibleRange.value, displayTimeZone.value)
  const mine = ++loadCount
  loading.value = true
  try {
    const { objects } = await fetchLinkObjects(slug.value, current.token, range)
    if (mine !== loadCount) return
    readProblem.value = null
    state.events.value = linkEvents(objects, {
      displayTimeZone: displayTimeZone.value,
      orgTimeZone: orgTimeZone.value,
      range,
    })
  } catch (error) {
    if (mine !== loadCount) return
    const kind = failureOf(error)
    if (kind === 'session' || kind === 'unavailable') close(kind)
    else readProblem.value = FAILURES[kind]()
  } finally {
    if (mine === loadCount) loading.value = false
  }
}

watch(
  () =>
    session.value
      ? `${session.value.token}|${rangeKey(visibleRange.value, displayTimeZone.value)}`
      : '',
  (key) => {
    if (key) void load()
  },
)

onMounted(() => {
  const stored = readStoredSession(slug.value)
  if (stored) show(stored)
  else void nextTick(() => passwordInput.value?.inputRef?.focus())
})

onBeforeUnmount(() => {
  linkView.value = null
})
</script>
