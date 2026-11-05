<!--
  The links of a calendar (FR-26a): on the access page, every link to the chosen calendar (admins);
  in Settings, the person's own links. A "Create link" button at the top opens the form: a label,
  the access level of a share ("Busy times only" or "Can view") and the password visitors enter.
  Each link opens to its address and its password. The password stays hidden until "Show password"
  is pressed; it is then asked from the server (each time is in the audit log) and kept in this
  component only, until it is hidden again, the link is closed or the component goes away (the
  access page renders one per calendar). A new link opens at once with its password hidden; the
  password typed for it is kept so that showing or copying it needs no call. In Settings, a
  calendar the person sees as busy times only offers "Busy times only" alone: "Can view" is
  disabled with a sentence why (the server refuses it too).
-->
<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <component
        :is="titleTag ?? 'h3'"
        :id="ids.heading"
        ref="heading"
        tabindex="-1"
        class="font-semibold focus:outline-none"
      >
        {{ title }}
      </component>
      <UButton
        v-if="!formOpen"
        ref="createToggle"
        :label="t('Create link')"
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        @click="openForm"
      />
    </div>
    <slot />

    <form
      v-if="formOpen"
      ref="form"
      novalidate
      class="flex flex-col gap-3 rounded-md border border-default p-3"
      :aria-label="t('New link')"
      :aria-busy="creating"
      @submit.prevent="create"
    >
      <UFormField
        v-if="calendarItems"
        :label="t('Calendar')"
        name="link-calendar"
        required
        :error="calendarError"
        :ui="FIELD_UI"
      >
        <USelect
          v-model="calendarHref"
          :items="calendarChoices"
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
        name="link-level"
        :help="
          busyOnly
            ? t(
                'You see this calendar as busy times only, so a link to it can show busy times only.',
              )
            : undefined
        "
        :error="levelError"
        :ui="FIELD_UI"
      >
        <URadioGroup
          v-model="level"
          :legend="t('Access level')"
          :items="levelItems"
          :ui="RADIO_UI"
          orientation="vertical"
        />
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
            :type="showTyped ? 'text' : 'password'"
            autocomplete="new-password"
            class="min-w-0 flex-1"
          />
          <UButton
            :icon="showTyped ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            color="neutral"
            variant="outline"
            square
            class="min-h-11 min-w-11 justify-center"
            :aria-label="t('Show password')"
            :aria-pressed="showTyped"
            @click="showTyped = !showTyped"
          />
        </div>
      </UFormField>
      <SettingsErrorAlert v-if="createAlert" :message="createAlert" />
      <div class="flex flex-wrap gap-2">
        <UButton
          type="submit"
          :label="creating ? t('Creating…') : t('Create link')"
          icon="i-lucide-link"
          :aria-busy="creating"
        />
        <UButton
          :label="t('Cancel')"
          color="neutral"
          variant="outline"
          :disabled="creating"
          @click="closeForm"
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
      <ul v-if="list.length > 0" :aria-labelledby="ids.heading" class="flex flex-col gap-2">
        <li
          v-for="link in list"
          :key="link.id"
          data-calendar-link
          class="flex flex-col gap-3 rounded-md border border-default p-3"
        >
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span
              class="size-3 shrink-0 rounded-full"
              :style="{ backgroundColor: link.calendarColor ?? 'var(--ui-text-muted)' }"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1 basis-48">
              <p
                :id="rowId(link.id, 'name')"
                tabindex="-1"
                class="font-medium wrap-anywhere focus:outline-none"
              >
                {{ link.label }}
              </p>
              <p class="text-sm text-toned wrap-anywhere">{{ summaryOf(link) }}</p>
            </div>
            <UButton
              :label="t('Details')"
              :trailing-icon="
                openRows.has(link.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
              "
              color="neutral"
              variant="outline"
              :aria-label="t('Details of {label}', { label: link.label })"
              :aria-expanded="openRows.has(link.id)"
              :aria-controls="rowId(link.id, 'details')"
              @click="toggleRow(link)"
            />
            <UButton
              :label="t('Remove')"
              icon="i-lucide-trash-2"
              color="neutral"
              variant="outline"
              :aria-label="t('Remove link {label}', { label: link.label })"
              :class="ERROR_TEXT"
              @click="askRemove(link)"
            />
          </div>

          <div
            v-if="openRows.has(link.id)"
            :id="rowId(link.id, 'details')"
            class="flex flex-col gap-2"
          >
            <dl
              class="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-y-2"
            >
              <template v-if="link.slug && !unavailable.has(link.id)">
                <dt class="text-sm font-medium">{{ t('Address') }}</dt>
                <dd class="flex gap-2">
                  <UInput
                    :id="rowId(link.id, 'address')"
                    :model-value="addressOf(link)"
                    readonly
                    autocomplete="off"
                    spellcheck="false"
                    class="min-w-0 flex-1"
                    :aria-label="t('Address of {label}', { label: link.label })"
                    :ui="{ base: 'font-mono' }"
                    @focus="selectAll"
                  />
                  <UButton
                    icon="i-lucide-copy"
                    color="neutral"
                    variant="outline"
                    square
                    class="min-h-11 min-w-11 justify-center"
                    :aria-label="t('Copy the address of {label}', { label: link.label })"
                    @click="copyAddress(link)"
                  />
                </dd>
                <dt class="text-sm font-medium">{{ t('Password') }}</dt>
                <dd class="flex gap-2">
                  <UInput
                    v-if="shownRows.has(link.id)"
                    :id="rowId(link.id, 'password')"
                    :model-value="passwords.get(link.id)"
                    readonly
                    autocomplete="off"
                    spellcheck="false"
                    class="min-w-0 flex-1"
                    :aria-label="t('Password of {label}', { label: link.label })"
                    :ui="{ base: 'font-mono' }"
                    @focus="selectAll"
                  />
                  <span v-else class="flex min-h-11 min-w-0 flex-1 items-center px-2.5 font-mono">
                    <span aria-hidden="true">••••••••••••</span>
                    <span class="sr-only">{{ t('Hidden') }}</span>
                  </span>
                  <UButton
                    :icon="shownRows.has(link.id) ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    color="neutral"
                    variant="outline"
                    square
                    class="min-h-11 min-w-11 justify-center"
                    :aria-label="t('Show the password of {label}', { label: link.label })"
                    :aria-pressed="shownRows.has(link.id)"
                    :aria-busy="revealing.has(link.id)"
                    @click="togglePassword(link)"
                  />
                  <UButton
                    icon="i-lucide-copy"
                    color="neutral"
                    variant="outline"
                    square
                    class="min-h-11 min-w-11 justify-center"
                    :aria-label="t('Copy the password of {label}', { label: link.label })"
                    :aria-busy="revealing.has(link.id)"
                    @click="copyPassword(link)"
                  />
                </dd>
              </template>
              <dt class="text-sm font-medium">{{ t('Created') }}</dt>
              <dd class="text-sm">
                <time :datetime="link.createdAt">{{
                  formatDateTime(link.createdAt, displayZone)
                }}</time>
              </dd>
              <dt class="text-sm font-medium">{{ t('Last opened') }}</dt>
              <dd class="text-sm">
                <time v-if="link.lastUsedAt" :datetime="link.lastUsedAt">{{
                  formatDateTime(link.lastUsedAt, displayZone)
                }}</time>
                <template v-else>{{ t('Never') }}</template>
              </dd>
            </dl>
            <p v-if="!link.slug || unavailable.has(link.id)" class="text-sm">
              {{
                t(
                  'The address and the password of this link cannot be shown. Remove it and create a new one if you need them.',
                )
              }}
            </p>
            <SettingsErrorAlert
              v-if="rowProblems.get(link.id)"
              :message="rowProblems.get(link.id)!"
            />
            <p role="status" aria-live="polite" class="min-h-5 text-sm">
              {{ rowNotices.get(link.id) }}
            </p>
          </div>
        </li>
      </ul>
      <p v-else class="text-toned">{{ emptyText }}</p>
    </template>
    <div v-else-if="!links.error.value" class="flex flex-col gap-2" role="status">
      <span class="sr-only">{{ t('Loading calendar links') }}</span>
      <USkeleton class="h-16 w-full" aria-hidden="true" />
    </div>

    <SettingsConfirmModal
      :open="removeTarget !== null"
      :title="t('Remove the link “{label}”?', { label: shownRemoveLabel })"
      :description="
        t('The address stops working at once, also for pages that are open. This cannot be undone.')
      "
      :confirm-label="t('Remove link')"
      :busy="removing"
      :error="removeError"
      :fallback="heading"
      @update:open="(open: boolean) => !open && (removeTarget = null)"
      @confirm="remove"
    />
  </div>
</template>

<script setup lang="ts">
import { useAuthFetch } from '~/composables/useAuthFetch'
import { levelLabel } from '~/utils/admin/access'
import { principalLabel } from '~/utils/principal-label'
import { N_, t, tv } from '~/utils/i18n'
import { describeError, parseApiError } from '~/utils/settings/api-errors'
import { formatDateTime } from '~/utils/settings/format'
import {
  LINK_LEVELS,
  MIN_LINK_PASSWORD_LENGTH,
  calendarLinkAddress,
  describeLinkCreateError,
  describeRevealError,
  linkEndpoints,
  validateLinkLabel,
  validateLinkPassword,
  type CalendarLinkItem,
  type LinkLevel,
} from '~/utils/settings/links'
import { createResource } from '~/utils/settings/resource'
import { ERROR_TEXT, FIELD_UI } from '~/utils/settings/ui'

const props = defineProps<{
  title: string
  titleTag?: 'h2' | 'h3'
  /** The links of this calendar of the access page (admins). Without it: the caller's own links. */
  calendarId?: number
  /** Its name, for the sentence of an empty list. */
  calendarName?: string
  /** The caller's own links: the calendars a link can be made to. */
  calendarItems?: readonly { label: string; value: string; freeBusyOnly?: boolean }[]
}>()

// 44 px rows for the radio buttons and the drop-down (design §9).
const RADIO_UI = { item: 'min-h-11 items-center' }
const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }

const api = useAuthFetch()
const displayZone = useDisplayTimeZone()
const origin = useRequestURL().origin
const endpoints = linkEndpoints(props.calendarId)
const forCalendar = props.calendarId !== undefined
const base = useId()
const ids = { heading: `${base}-heading` }

function rowId(id: number, part: string): string {
  return `${base}-${id}-${part}`
}

const links = createResource(
  () => api<{ links: CalendarLinkItem[] }>(endpoints.list),
  forCalendar ? N_('load the links') : N_('load your calendar links'),
)
onMounted(() => links.reload())
const list = computed(() => links.data.value?.links ?? [])

const heading = useTemplateRef<HTMLElement>('heading')
const createToggle = useTemplateRef<{ $el: HTMLElement }>('createToggle')
const form = useTemplateRef<HTMLFormElement>('form')
const passwordInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('passwordInput')
const notice = ref('')

const emptyText = computed(() =>
  forCalendar
    ? t('There are no links to {name} yet.', { name: props.calendarName ?? '' })
    : t('You have no calendar links yet.'),
)

const calendarChoices = computed(() =>
  (props.calendarItems ?? []).map(({ label, value }) => ({ label, value })),
)

const levelItems = computed(() =>
  LINK_LEVELS.map((item) => ({
    value: item.value as string,
    label: tv(item.label),
    description: tv(item.help),
    disabled: item.value === 'read' && busyOnly.value,
  })),
)

function summaryOf(link: CalendarLinkItem): string {
  const parts = [levelLabel(link.level)]
  if (forCalendar) {
    parts.push(
      link.readsAs === 'maker'
        ? t('made by {name} in Settings', { name: principalLabel('user', link.maker) })
        : t('made by {name}', { name: principalLabel('user', link.maker) }),
    )
  } else {
    parts.unshift(link.calendarName)
  }
  return parts.join(' · ')
}

function addressOf(link: CalendarLinkItem): string {
  return link.slug ? calendarLinkAddress(origin, link.slug) : ''
}

function selectAll(event: FocusEvent) {
  if (event.target instanceof HTMLInputElement) event.target.select()
}

// ---- Making a link ------------------------------------------------------------------------------

const formOpen = ref(false)
const calendarHref = ref<string | undefined>(undefined)
const label = ref('')
const level = ref<string>('read')
const password = ref('')
const showTyped = ref(false)
const submitted = ref(false)
const serverErrors = ref<Record<string, string>>({})
const createAlert = ref<string | null>(null)
const creating = ref(false)

const calendarError = computed(
  () =>
    (submitted.value && props.calendarItems && !calendarHref.value
      ? t('Choose a calendar.')
      : undefined) ?? serverErrors.value.calendarHref,
)
const labelError = computed(
  () => (submitted.value ? validateLinkLabel(label.value) : undefined) ?? serverErrors.value.label,
)
const levelError = computed(() => serverErrors.value.level)
const passwordError = computed(
  () =>
    (submitted.value ? validateLinkPassword(password.value) : undefined) ??
    serverErrors.value.password,
)

watch([calendarHref, label, level, password], () => {
  serverErrors.value = {}
})

/** The chosen calendar is one the person sees as busy times only: a link can show no more. */
const busyOnly = computed(
  () =>
    props.calendarItems?.find((item) => item.value === calendarHref.value)?.freeBusyOnly === true,
)
watch(busyOnly, (only) => {
  if (only && level.value === 'read') level.value = 'free_busy'
})

function resetForm() {
  calendarHref.value = undefined
  label.value = ''
  level.value = 'read'
  password.value = ''
  showTyped.value = false
  submitted.value = false
  serverErrors.value = {}
  createAlert.value = null
}

async function openForm() {
  resetForm()
  notice.value = ''
  formOpen.value = true
  await nextTick()
  // The first field: the calendar's drop-down in Settings, the label on the access page.
  form.value?.querySelector<HTMLElement>('button, input')?.focus()
}

async function closeForm() {
  formOpen.value = false
  resetForm()
  await nextTick()
  createToggle.value?.$el.focus()
}

async function create() {
  if (creating.value) return
  submitted.value = true
  createAlert.value = null
  notice.value = ''
  if (calendarError.value || labelError.value || passwordError.value) return
  creating.value = true
  const typed = password.value
  try {
    const { link } = await api<{ link: CalendarLinkItem }>(endpoints.create, {
      method: 'POST',
      body: {
        ...(props.calendarItems ? { calendarHref: calendarHref.value } : {}),
        ...(label.value.trim() ? { label: label.value.trim() } : {}),
        level: level.value as LinkLevel,
        password: typed,
      },
    })
    links.update((current) => ({ links: [link, ...current.links] }))
    // Opened, with the password hidden; the one just typed is kept so Show needs no call.
    passwords.set(link.id, typed)
    openRows.add(link.id)
    formOpen.value = false
    resetForm()
    notice.value = t(
      'Link “{label}” created. Send the address and the password, ideally on different ways.',
      { label: link.label },
    )
    await nextTick()
    document.getElementById(rowId(link.id, 'name'))?.focus()
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

// ---- Address and password of a link -------------------------------------------------------------

const openRows = reactive(new Set<number>())
/** The passwords this component has, by link: shown ones and the one of a link just made. */
const passwords = reactive(new Map<number, string>())
const shownRows = reactive(new Set<number>())
const revealing = reactive(new Set<number>())
const unavailable = reactive(new Set<number>())
const rowProblems = reactive(new Map<number, string>())
const rowNotices = reactive(new Map<number, string>())

function forget(id: number) {
  passwords.delete(id)
  shownRows.delete(id)
}

function toggleRow(link: CalendarLinkItem) {
  if (openRows.has(link.id)) {
    openRows.delete(link.id)
    forget(link.id)
    rowProblems.delete(link.id)
    rowNotices.delete(link.id)
  } else {
    openRows.add(link.id)
  }
}

/** The password of the link: kept here, or asked from the server. Null when there is none. */
async function passwordOf(link: CalendarLinkItem): Promise<string | null> {
  const kept = passwords.get(link.id)
  if (kept !== undefined) return kept
  if (revealing.has(link.id)) return null
  revealing.add(link.id)
  rowProblems.delete(link.id)
  try {
    const { password: value } = await api<{ password: string }>(endpoints.reveal(link.id), {
      method: 'POST',
    })
    return value
  } catch (cause) {
    const failure = describeRevealError(cause)
    if (failure.kind === 'not_available') unavailable.add(link.id)
    else if (failure.kind === 'gone') {
      dropLink(link, t('This link no longer exists.'))
      void nextTick(() => heading.value?.focus())
    } else rowProblems.set(link.id, failure.message)
    return null
  } finally {
    revealing.delete(link.id)
  }
}

async function togglePassword(link: CalendarLinkItem) {
  rowNotices.delete(link.id)
  if (shownRows.has(link.id)) {
    forget(link.id)
    return
  }
  const value = await passwordOf(link)
  if (value === null || !openRows.has(link.id)) return
  passwords.set(link.id, value)
  shownRows.add(link.id)
}

async function copyText(link: CalendarLinkItem, value: string, field: 'address' | 'password') {
  rowNotices.delete(link.id)
  await nextTick()
  try {
    await navigator.clipboard.writeText(value)
    rowNotices.set(link.id, t('Copied to the clipboard.'))
  } catch {
    // Selected in its field, for Ctrl+C.
    if (field === 'password') {
      passwords.set(link.id, value)
      shownRows.add(link.id)
    }
    await nextTick()
    const input = document.getElementById(rowId(link.id, field))
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
    rowNotices.set(
      link.id,
      field === 'address'
        ? t('Could not copy automatically. The address is selected: press Ctrl+C to copy it.')
        : t('Could not copy automatically. The password is selected: press Ctrl+C to copy it.'),
    )
  }
}

function copyAddress(link: CalendarLinkItem) {
  const address = addressOf(link)
  if (address) void copyText(link, address, 'address')
}

async function copyPassword(link: CalendarLinkItem) {
  const value = await passwordOf(link)
  if (value !== null && openRows.has(link.id)) await copyText(link, value, 'password')
}

onBeforeUnmount(() => {
  passwords.clear()
  shownRows.clear()
})

// ---- Removing a link ----------------------------------------------------------------------------

const removeTarget = ref<CalendarLinkItem | null>(null)
const shownRemoveLabel = ref('')
const removing = ref(false)
const removeError = ref<string | null>(null)

function askRemove(link: CalendarLinkItem) {
  removeError.value = null
  shownRemoveLabel.value = link.label
  removeTarget.value = link
}

function dropLink(link: CalendarLinkItem, message: string) {
  links.update((current) => ({ links: current.links.filter((item) => item.id !== link.id) }))
  openRows.delete(link.id)
  forget(link.id)
  unavailable.delete(link.id)
  rowProblems.delete(link.id)
  rowNotices.delete(link.id)
  notice.value = message
}

async function remove() {
  const target = removeTarget.value
  if (!target || removing.value) return
  removing.value = true
  removeError.value = null
  try {
    await api(endpoints.item(target.id), { method: 'DELETE' })
  } catch (cause) {
    if (parseApiError(cause).kind !== 'not-found') {
      removeError.value = describeError(cause, N_('remove the link'))
      removing.value = false
      return
    }
  }
  dropLink(target, t('Link “{label}” removed.', { label: target.label }))
  removeTarget.value = null
  removing.value = false
}
</script>
