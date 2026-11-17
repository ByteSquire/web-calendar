<!--
  The links of a calendar (FR-26a): on the access page, every link to the chosen calendar (admins);
  in Settings, the person's own links. The heading row has "Create link", which opens a dialog with
  the form: a label, the access level of a share ("Busy times only" or "Can view") and the password
  visitors enter. A row shows the calendar's colour, the label, a summary and "Details", nothing of
  the password. "Details" opens a dialog with the address (with Copy), the password, the dates and
  "Remove link" (asked first). The password stays hidden until "Show the password of …" is
  pressed; it is then asked from the server (each time is in the audit log) and kept in this
  component only, until it is hidden again, the dialog closes or the component goes away (the
  access page renders one per calendar). After a link is made, the same dialog turns into its
  details, with the password typed for it kept so that showing or copying it needs no call. What
  happened (created, removed) is told in a toast, so the list never moves; a failed request is
  told in the dialog and in a toast. In Settings, a calendar the person sees as busy times only
  offers "Busy times only" alone: "Can view" is disabled with a sentence why (the server refuses
  it too).
-->
<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <component
        :is="titleTag ?? 'h3'"
        :id="ids.heading"
        ref="heading"
        tabindex="-1"
        :class="[titleTag === 'h2' ? 'text-lg' : '', 'font-semibold focus:outline-none']"
      >
        {{ title }}
      </component>
      <UButton
        :label="t('Create link')"
        icon="i-lucide-plus"
        aria-haspopup="dialog"
        @click="openForm"
      />
    </div>
    <slot />

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
          class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
        >
          <span
            class="size-3 shrink-0 rounded-full"
            :style="{ backgroundColor: link.calendarColor ?? 'var(--ui-text-muted)' }"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1 basis-48">
            <p class="font-medium wrap-anywhere">{{ link.label }}</p>
            <p class="text-sm text-toned wrap-anywhere">{{ summaryOf(link) }}</p>
          </div>
          <UButton
            :label="t('Details')"
            color="neutral"
            variant="outline"
            aria-haspopup="dialog"
            :aria-label="t('Details of {label}', { label: link.label })"
            @click="openDetails(link)"
          />
        </li>
      </ul>
      <p v-else class="text-toned">{{ emptyText }}</p>
    </template>
    <div v-else-if="!links.error.value" class="flex flex-col gap-2" role="status">
      <span class="sr-only">{{ t('Loading calendar links') }}</span>
      <USkeleton class="h-16 w-full" aria-hidden="true" />
    </div>

    <!-- The form of a new link, then (after creating it) the details of a link. -->
    <UModal
      :open="mode !== null"
      :title="shownHeader.title"
      :description="shownHeader.description"
      :content="{ onOpenAutoFocus: focusFirst, onCloseAutoFocus: dialogFocus.restore }"
      :ui="{ title: 'wrap-anywhere', description: 'wrap-anywhere' }"
      @update:open="(open: boolean) => !open && closeDialog()"
    >
      <template #body>
        <form
          v-if="mode === 'create'"
          :id="ids.form"
          ref="form"
          novalidate
          class="flex flex-col gap-3"
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
        </form>

        <div v-else-if="mode === 'details' && current" class="flex flex-col gap-3">
          <dl
            class="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-y-2"
          >
            <template v-if="current.slug && !unavailable.has(current.id)">
              <dt class="text-sm font-medium">{{ t('Address') }}</dt>
              <dd class="flex gap-2">
                <UInput
                  :id="ids.address"
                  :model-value="addressOf(current)"
                  readonly
                  autocomplete="off"
                  spellcheck="false"
                  class="min-w-0 flex-1"
                  :aria-label="t('Address of {label}', { label: current.label })"
                  :ui="{ base: 'font-mono' }"
                  @focus="selectAll"
                />
                <UButton
                  icon="i-lucide-copy"
                  color="neutral"
                  variant="outline"
                  square
                  class="min-h-11 min-w-11 justify-center"
                  :aria-label="t('Copy the address of {label}', { label: current.label })"
                  @click="copyAddress(current)"
                />
              </dd>
              <dt class="text-sm font-medium">{{ t('Password') }}</dt>
              <dd class="flex gap-2">
                <UInput
                  v-if="shown"
                  :id="ids.password"
                  :model-value="knownPassword ?? ''"
                  readonly
                  autocomplete="off"
                  spellcheck="false"
                  class="min-w-0 flex-1"
                  :aria-label="t('Password of {label}', { label: current.label })"
                  :ui="{ base: 'font-mono' }"
                  @focus="selectAll"
                />
                <span v-else class="flex min-h-11 min-w-0 flex-1 items-center px-2.5 font-mono">
                  <span aria-hidden="true">••••••••••••</span>
                  <span class="sr-only">{{ t('Hidden') }}</span>
                </span>
                <UButton
                  :icon="shown ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  color="neutral"
                  variant="outline"
                  square
                  class="min-h-11 min-w-11 justify-center"
                  :aria-label="t('Show the password of {label}', { label: current.label })"
                  :aria-pressed="shown"
                  :aria-busy="revealing"
                  @click="togglePassword(current)"
                />
                <UButton
                  icon="i-lucide-copy"
                  color="neutral"
                  variant="outline"
                  square
                  class="min-h-11 min-w-11 justify-center"
                  :aria-label="t('Copy the password of {label}', { label: current.label })"
                  :aria-busy="revealing"
                  @click="copyPassword(current)"
                />
              </dd>
            </template>
            <dt class="text-sm font-medium">{{ t('Created') }}</dt>
            <dd class="text-sm">
              <time :datetime="current.createdAt">{{
                formatDateTime(current.createdAt, displayZone)
              }}</time>
            </dd>
            <dt class="text-sm font-medium">{{ t('Last opened') }}</dt>
            <dd class="text-sm">
              <time v-if="current.lastUsedAt" :datetime="current.lastUsedAt">{{
                formatDateTime(current.lastUsedAt, displayZone)
              }}</time>
              <template v-else>{{ t('Never') }}</template>
            </dd>
          </dl>
          <p v-if="!current.slug || unavailable.has(current.id)" class="text-sm">
            {{
              t(
                'The address and the password of this link cannot be shown. Remove it and create a new one if you need them.',
              )
            }}
          </p>
          <SettingsErrorAlert v-if="problem" :message="problem" />
          <!-- Present from the start and only its text changes, so screen readers announce it. -->
          <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ copyNotice }}</p>
        </div>
      </template>

      <template #footer>
        <div v-if="mode === 'create'" class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            :label="t('Cancel')"
            color="neutral"
            variant="outline"
            :disabled="creating"
            @click="closeDialog"
          />
          <UButton
            type="submit"
            :form="ids.form"
            :label="creating ? t('Creating…') : t('Create link')"
            icon="i-lucide-link"
            :aria-busy="creating"
          />
        </div>
        <div
          v-else-if="mode === 'details' && current"
          class="flex w-full flex-wrap justify-between gap-2"
        >
          <UButton
            :label="t('Remove link')"
            icon="i-lucide-trash-2"
            color="neutral"
            variant="outline"
            :aria-label="t('Remove link {label}', { label: current.label })"
            :class="ERROR_TEXT"
            @click="askRemove(current)"
          />
          <UButton ref="closeButton" :label="t('Done')" @click="closeDialog" />
        </div>
      </template>
    </UModal>

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
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { principalLabel } from '~/utils/principal-label'
import { N_, t, tv } from '~/utils/i18n'
import { describeError, parseApiError } from '~/utils/settings/api-errors'
import { createFocusReturn } from '~/utils/settings/focus-return'
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
  /** The id of the heading, for a section around it that is named by it. */
  headingId?: string
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
const notify = useNotify()
const displayZone = useDisplayTimeZone()
const origin = useRequestURL().origin
const endpoints = linkEndpoints(props.calendarId)
const forCalendar = props.calendarId !== undefined
const base = useId()
const ids = {
  heading: props.headingId ?? `${base}-heading`,
  form: `${base}-form`,
  address: `${base}-address`,
  password: `${base}-password`,
}

const links = createResource(
  () => api<{ links: CalendarLinkItem[] }>(endpoints.list),
  forCalendar ? N_('load the links') : N_('load your calendar links'),
)
onMounted(() => links.reload())
const list = computed(() => links.data.value?.links ?? [])

const heading = useTemplateRef<HTMLElement>('heading')
const form = useTemplateRef<HTMLFormElement>('form')
const passwordInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('passwordInput')
const closeButton = useTemplateRef<{ $el: HTMLElement }>('closeButton')

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
        ? t('created by {name} in Settings', { name: principalLabel('user', link.maker) })
        : t('created by {name}', { name: principalLabel('user', link.maker) }),
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

// ---- The dialog -----------------------------------------------------------------------------------

/** What the dialog shows: the form of a new link or the details of `current`; null: closed. */
const mode = ref<'create' | 'details' | null>(null)
const current = ref<CalendarLinkItem | null>(null)
const dialogFocus = createFocusReturn(() => heading.value)

const header = computed(() =>
  mode.value === 'details' && current.value
    ? { title: current.value.label, description: summaryOf(current.value) }
    : {
        title: t('New link'),
        description: t('Visitors open the link with the password you choose here.'),
      },
)
// Kept while the dialog fades out, when what it showed is gone already.
const shownHeader = ref(header.value)
watch(header, (value) => {
  if (mode.value !== null) shownHeader.value = value
})

function openDialog(next: 'create' | 'details', link: CalendarLinkItem | null) {
  dialogFocus.remember()
  current.value = link
  mode.value = next
  shownHeader.value = header.value
}

function closeDialog() {
  // A request in flight cannot be taken back: stay open until it has answered.
  if (creating.value) return
  mode.value = null
  current.value = null
  resetForm()
  forget()
}

/** The first field of the form; the address of a link (or Done, when it has none). */
function focusFirst(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  focusInDialog()
}

function focusInDialog() {
  if (mode.value === 'create') {
    // The calendar's drop-down in Settings, the label on the access page.
    form.value?.querySelector<HTMLElement>('button, input')?.focus()
    return
  }
  const address = document.getElementById(ids.address)
  if (address) address.focus()
  else closeButton.value?.$el.focus()
}

// ---- Making a link ------------------------------------------------------------------------------

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

function openForm() {
  resetForm()
  openDialog('create', null)
}

async function create() {
  if (creating.value) return
  submitted.value = true
  createAlert.value = null
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
    links.update((value) => ({ links: [link, ...value.links] }))
    notify.done(
      t('Link “{label}” created. Send the address and the password, ideally by different routes.', {
        label: link.label,
      }),
    )
    // The dialog turns into the link's details, with the password hidden; the one just typed is
    // kept so Show and Copy need no call.
    resetForm()
    forget()
    knownPassword.value = typed
    current.value = link
    mode.value = 'details'
    await nextTick()
    focusInDialog()
  } catch (cause) {
    const failure = describeLinkCreateError(cause)
    serverErrors.value = failure.byField
    createAlert.value = failure.alert ?? null
    const summary = failure.alert ?? Object.values(failure.byField)[0]
    if (summary) notify.failed(summary)
    await nextTick()
    if (failure.byField.password) passwordInput.value?.inputRef?.focus()
  } finally {
    creating.value = false
  }
}

// ---- Address and password of a link -------------------------------------------------------------

function openDetails(link: CalendarLinkItem) {
  forget()
  openDialog('details', link)
}

/** The password of the open link this component has: the shown one, or the one just typed. */
const knownPassword = ref<string | null>(null)
const shown = ref(false)
const revealing = ref(false)
/** Links whose address and password the server cannot give. */
const unavailable = reactive(new Set<number>())
const problem = ref<string | null>(null)
const copyNotice = ref('')

function forget() {
  knownPassword.value = null
  shown.value = false
  problem.value = null
  copyNotice.value = ''
}

/** The dialog still shows this link: an answer for one that was closed meanwhile is dropped. */
function stillOpen(link: CalendarLinkItem): boolean {
  return mode.value === 'details' && current.value?.id === link.id
}

/** The password of the link: kept here, or asked from the server. Null when there is none. */
async function passwordOf(link: CalendarLinkItem): Promise<string | null> {
  if (knownPassword.value !== null) return knownPassword.value
  if (revealing.value) return null
  revealing.value = true
  problem.value = null
  try {
    const { password: value } = await api<{ password: string }>(endpoints.reveal(link.id), {
      method: 'POST',
    })
    return stillOpen(link) ? value : null
  } catch (cause) {
    if (!stillOpen(link)) return null
    const failure = describeRevealError(cause)
    if (failure.kind === 'not_available') unavailable.add(link.id)
    else if (failure.kind === 'gone') {
      dropLink(link)
      notify.failed(t('This link no longer exists.'))
      closeDialog()
    } else {
      problem.value = failure.message
      notify.failed(failure.message)
    }
    return null
  } finally {
    revealing.value = false
  }
}

async function togglePassword(link: CalendarLinkItem) {
  copyNotice.value = ''
  if (shown.value) {
    forget()
    return
  }
  const value = await passwordOf(link)
  if (value === null || !stillOpen(link)) return
  knownPassword.value = value
  shown.value = true
}

async function copyText(value: string, field: 'address' | 'password') {
  copyNotice.value = ''
  await nextTick()
  try {
    await navigator.clipboard.writeText(value)
    copyNotice.value = t('Copied to the clipboard.')
  } catch {
    // Selected in its field, for Ctrl+C.
    if (field === 'password') {
      knownPassword.value = value
      shown.value = true
    }
    await nextTick()
    const input = document.getElementById(field === 'address' ? ids.address : ids.password)
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
    copyNotice.value =
      field === 'address'
        ? t('Could not copy automatically. The address is selected: press Ctrl+C to copy it.')
        : t('Could not copy automatically. The password is selected: press Ctrl+C to copy it.')
  }
}

function copyAddress(link: CalendarLinkItem) {
  const address = addressOf(link)
  if (address) void copyText(address, 'address')
}

async function copyPassword(link: CalendarLinkItem) {
  const value = await passwordOf(link)
  if (value !== null && stillOpen(link)) await copyText(value, 'password')
}

onBeforeUnmount(() => {
  forget()
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

function dropLink(link: CalendarLinkItem) {
  links.update((value) => ({ links: value.links.filter((item) => item.id !== link.id) }))
  unavailable.delete(link.id)
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
      notify.failed(removeError.value)
      removing.value = false
      return
    }
  }
  dropLink(target)
  notify.done(t('Link “{label}” removed.', { label: target.label }))
  removeTarget.value = null
  removing.value = false
  // The details of a link that is gone have nothing left to show.
  if (current.value?.id === target.id) closeDialog()
}
</script>
