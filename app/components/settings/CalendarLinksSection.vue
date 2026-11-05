<!--
  Calendar links: a read-only page of one calendar for people without an account, behind a
  password. Any calendar the person can view (their own, a shared one, a group's) can have links;
  a calendar they see as busy times only cannot. The address is shown once, in a panel that
  replaces the form until "Done", and is kept only in this component (never in shared state or
  storage). The link shows titles, times and places, never descriptions or the people invited;
  it reads the calendar as the person who made it, so it stops when they lose access, and while
  they have not signed in for the sign-in window. Design note: on this page, next to the app
  tokens, because it is the same kind of thing (a credential that outlives the session) and the
  sidebar has no room for a list with secrets. Not in demo mode.
-->
<template>
  <section aria-labelledby="settings-links" class="flex flex-col gap-4">
    <h2 id="settings-links" ref="heading" tabindex="-1" class="text-lg font-semibold">
      {{ t('Calendar links') }}
    </h2>
    <div class="flex flex-col gap-2">
      <p>
        {{
          t(
            'Give people without an account a read-only view of one of your calendars. They open the link and enter the password you choose here.',
          )
        }}
      </p>
      <p class="text-sm text-toned">
        {{
          t(
            'The link shows the title, time and place of each event, never descriptions or the people invited; private events show as busy. It shows what you can see, and stops working when you lose access to the calendar or do not sign in to this app for {days}.',
            { days: tc('{count} day | {count} days', windowDays) },
          )
        }}
      </p>
    </div>

    <!-- The address, once. -->
    <div
      v-if="created"
      role="group"
      aria-labelledby="settings-link-created"
      class="flex flex-col gap-3 rounded-lg border-2 border-accented p-4"
    >
      <h3 id="settings-link-created" class="font-semibold wrap-anywhere">
        {{ t('New link to “{name}”', { name: created.link.calendarName }) }}
      </h3>
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="t('Copy it now')"
        :description="
          t(
            'This address is shown only once. Send it with the password, ideally on different ways. If you lose it, withdraw the link and make a new one.',
          )
        "
      />
      <UFormField :label="t('Address')" name="new-link">
        <div class="flex gap-2">
          <UInput
            ref="addressInput"
            :model-value="createdAddress"
            readonly
            autocomplete="off"
            spellcheck="false"
            class="min-w-0 flex-1"
            :ui="{ base: 'font-mono' }"
            @focus="selectAddress"
          />
          <UButton :label="t('Copy')" icon="i-lucide-copy" color="neutral" @click="copyAddress" />
        </div>
      </UFormField>
      <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ copyStatus }}</p>
      <div>
        <UButton :label="t('Done')" @click="dismissCreated" />
      </div>
    </div>

    <form v-else novalidate class="flex flex-col gap-3" @submit.prevent="createLink">
      <UFormField
        :label="t('Calendar')"
        name="link-calendar"
        required
        :error="calendarError"
        :ui="FIELD_UI"
      >
        <USelect
          v-model="calendarHref"
          :items="calendarItems"
          :placeholder="t('Choose a calendar')"
          class="w-full"
          :ui="SELECT_UI"
        />
      </UFormField>
      <UFormField
        :label="t('Label')"
        name="link-label"
        :help="t('Who is the link for? Optional; the calendar name if empty.')"
        :error="labelError"
        :ui="FIELD_UI"
      >
        <UInput v-model="label" autocomplete="off" class="w-full" />
      </UFormField>
      <UFormField
        :label="t('Password')"
        name="link-password"
        required
        :help="
          t('At least {min} characters. Visitors need it to open the link.', {
            min: MIN_LINK_PASSWORD_LENGTH,
          })
        "
        :error="passwordError"
        :ui="FIELD_UI"
      >
        <div class="flex gap-2">
          <UInput
            ref="passwordInput"
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            class="min-w-0 flex-1"
          />
          <UButton
            :icon="showPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            color="neutral"
            variant="outline"
            square
            class="min-h-11 min-w-11 justify-center"
            :aria-label="t('Show password')"
            :aria-pressed="showPassword"
            @click="showPassword = !showPassword"
          />
        </div>
      </UFormField>
      <SettingsErrorAlert v-if="createAlert" :message="createAlert" />
      <div>
        <UButton
          type="submit"
          :label="creating ? t('Making…') : t('Make link')"
          icon="i-lucide-link"
          :aria-busy="creating"
        />
      </div>
    </form>

    <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>

    <SettingsErrorAlert
      v-if="links.error.value"
      :message="links.error.value"
      retryable
      @retry="links.reload()"
    />
    <template v-if="links.data.value">
      <ul
        v-if="links.data.value.links.length > 0"
        :aria-label="t('Your calendar links')"
        class="flex flex-col gap-2"
      >
        <li
          v-for="link in links.data.value.links"
          :key="link.id"
          class="flex flex-col gap-2 rounded-lg border border-default p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <p class="flex flex-wrap items-center gap-2 font-medium">
              <span
                class="size-3 shrink-0 rounded-full"
                :style="{ backgroundColor: link.calendarColor ?? 'var(--ui-text-muted)' }"
                aria-hidden="true"
              />
              <span class="wrap-anywhere">{{ link.label }}</span>
            </p>
            <dl class="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-sm text-toned">
              <dt>{{ t('Calendar') }}</dt>
              <dd class="wrap-anywhere">{{ link.calendarName }}</dd>
              <dt>{{ t('Created') }}</dt>
              <dd>
                <time :datetime="link.createdAt">{{
                  formatDateTime(link.createdAt, displayZone)
                }}</time>
              </dd>
              <dt>{{ t('Last opened') }}</dt>
              <dd>
                <time v-if="link.lastUsedAt" :datetime="link.lastUsedAt">{{
                  formatDateTime(link.lastUsedAt, displayZone)
                }}</time>
                <template v-else>{{ t('Never') }}</template>
              </dd>
            </dl>
          </div>
          <UButton
            :label="t('Withdraw')"
            icon="i-lucide-trash-2"
            color="neutral"
            variant="outline"
            :aria-label="t('Withdraw link {label}', { label: link.label })"
            :class="ERROR_TEXT"
            @click="askWithdraw(link)"
          />
        </li>
      </ul>
      <p v-else>{{ t('You have no calendar links yet.') }}</p>
    </template>
    <div v-else-if="!links.error.value" class="flex flex-col gap-2" role="status">
      <span class="sr-only">{{ t('Loading calendar links') }}</span>
      <USkeleton class="h-20 w-full" aria-hidden="true" />
    </div>

    <SettingsConfirmModal
      :open="withdrawTarget !== null"
      :title="t('Withdraw the link “{label}”?', { label: shownWithdrawLabel })"
      :description="
        t('The address stops working at once, also for pages that are open. This cannot be undone.')
      "
      :confirm-label="t('Withdraw link')"
      :busy="withdrawing"
      :error="withdrawError"
      :fallback="heading"
      @update:open="(open: boolean) => !open && (withdrawTarget = null)"
      @confirm="withdrawLink"
    />
  </section>
</template>

<script setup lang="ts">
import { useAuthFetch } from '~/composables/useAuthFetch'
import { N_, t, tc } from '~/utils/i18n'
import { describeError, parseApiError } from '~/utils/settings/api-errors'
import { formatDateTime } from '~/utils/settings/format'
import {
  MIN_LINK_PASSWORD_LENGTH,
  calendarLinkAddress,
  describeLinkCreateError,
  validateLinkLabel,
  validateLinkPassword,
  type CalendarLinkItem,
  type CreatedCalendarLink,
} from '~/utils/settings/links'
import { createResource } from '~/utils/settings/resource'
import { ERROR_TEXT, FIELD_UI } from '~/utils/settings/ui'

const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }

const api = useAuthFetch()
const serverConfig = useServerConfigState()
const windowDays = computed(() => serverConfig.value?.signinWindowDays ?? 30)
const displayZone = useDisplayTimeZone()
const origin = useRequestURL().origin
const { calendars } = useCalendarState()

const links = createResource(
  () => api<{ links: CalendarLinkItem[] }>('/api/calendar-links'),
  N_('load your calendar links'),
)
onMounted(() => links.reload())

const heading = useTemplateRef<HTMLElement>('heading')
const passwordInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('passwordInput')
const addressInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('addressInput')
const notice = ref('')

// The calendars of the built-in service the person sees (their own, shared and group ones).
const calendarItems = computed(() =>
  calendars.value
    .filter(
      (calendar) => calendar.type === 'caldav' && calendar.id.startsWith('dav:') && calendar.href,
    )
    .map((calendar) => ({ label: calendar.name, value: calendar.href! })),
)

// ---- Making a link ------------------------------------------------------------------------------

const calendarHref = ref<string | undefined>(undefined)
const label = ref('')
const password = ref('')
const showPassword = ref(false)
const submitted = ref(false)
const serverErrors = ref<Record<string, string>>({})
const createAlert = ref<string | null>(null)
const creating = ref(false)
const created = ref<CreatedCalendarLink | null>(null)
const copyStatus = ref('')
const createdAddress = computed(() =>
  created.value ? calendarLinkAddress(origin, created.value.slug) : '',
)

const calendarError = computed(
  () =>
    (submitted.value && !calendarHref.value ? t('Choose a calendar.') : undefined) ??
    serverErrors.value.calendarHref,
)
const labelError = computed(
  () => (submitted.value ? validateLinkLabel(label.value) : undefined) ?? serverErrors.value.label,
)
const passwordError = computed(
  () =>
    (submitted.value ? validateLinkPassword(password.value) : undefined) ??
    serverErrors.value.password,
)

watch([calendarHref, label, password], () => {
  serverErrors.value = {}
})

async function createLink() {
  if (creating.value) return
  submitted.value = true
  createAlert.value = null
  notice.value = ''
  if (calendarError.value || labelError.value || passwordError.value) return
  creating.value = true
  try {
    created.value = await api<CreatedCalendarLink>('/api/calendar-links', {
      method: 'POST',
      body: {
        calendarHref: calendarHref.value,
        ...(label.value.trim() ? { label: label.value.trim() } : {}),
        password: password.value,
      },
    })
    label.value = ''
    password.value = ''
    showPassword.value = false
    submitted.value = false
    copyStatus.value = ''
    void links.reload()
    await nextTick()
    addressInput.value?.inputRef?.focus()
  } catch (cause) {
    const failure = describeLinkCreateError(cause)
    serverErrors.value = failure.byField
    createAlert.value = failure.alert ?? null
    await nextTick()
    if (failure.byField.password) passwordInput.value?.inputRef?.focus()
  } finally {
    creating.value = false
  }
}

function selectAddress(event: FocusEvent) {
  if (event.target instanceof HTMLInputElement) event.target.select()
}

async function copyAddress() {
  const address = createdAddress.value
  if (!address) return
  copyStatus.value = ''
  await nextTick()
  try {
    await navigator.clipboard.writeText(address)
    copyStatus.value = t('Copied to the clipboard.')
  } catch {
    addressInput.value?.inputRef?.focus()
    copyStatus.value = t(
      'Could not copy automatically. The address is selected: press Ctrl+C to copy it.',
    )
  }
}

async function dismissCreated() {
  created.value = null
  copyStatus.value = ''
  await nextTick()
  heading.value?.focus()
}

onBeforeUnmount(() => {
  created.value = null
})

// ---- Withdrawing a link -------------------------------------------------------------------------

const withdrawTarget = ref<CalendarLinkItem | null>(null)
const shownWithdrawLabel = ref('')
const withdrawing = ref(false)
const withdrawError = ref<string | null>(null)

function askWithdraw(link: CalendarLinkItem) {
  withdrawError.value = null
  shownWithdrawLabel.value = link.label
  withdrawTarget.value = link
}

async function withdrawLink() {
  const target = withdrawTarget.value
  if (!target || withdrawing.value) return
  withdrawing.value = true
  withdrawError.value = null
  try {
    await api(`/api/calendar-links/${target.id}`, { method: 'DELETE' })
  } catch (cause) {
    if (parseApiError(cause).kind !== 'not-found') {
      withdrawError.value = describeError(cause, N_('withdraw the link'))
      withdrawing.value = false
      return
    }
  }
  links.update((current) => ({ links: current.links.filter((link) => link.id !== target.id) }))
  notice.value = t('Link “{label}” withdrawn.', { label: target.label })
  withdrawTarget.value = null
  withdrawing.value = false
}
</script>
