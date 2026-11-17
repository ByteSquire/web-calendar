<!--
  External CalDAV accounts (FR-8): the calendars of another CalDAV server, read-only. Browsers cannot
  call other servers, so this app's server passes each request on; it keeps the account's address
  and name but never the password. For an account with a login the server seals the password, and
  this browser keeps the sealed text (in memory, or on the device when the person asks): see
  utils/external/seals.ts. "Add account", beside the heading, and "Edit" on a row open the same
  dialog with ExternalAccountForm; it closes when the server has taken the change and stays open
  with the reason when not. At the limit the button is disabled; the sentence beside it, there
  from the start, says how many accounts there are and why. What happened is told in a toast and a
  failed request also in the dialog, so the list never moves. "Check connection" runs the same
  discovery the calendar view runs and reports in the row, on the status line it always has.
  Every change bumps `calendar-sources-version`, which the calendar view watches to load again.
-->
<template>
  <section aria-labelledby="settings-external" class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 id="settings-external" ref="heading" tabindex="-1" class="text-lg font-semibold">
        {{ t('External CalDAV accounts') }}
      </h2>
      <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <p v-if="list" id="settings-external-limit" class="text-sm text-toned">
          <UIcon
            v-if="limitReached"
            name="i-lucide-info"
            class="mr-1 inline size-4 align-text-bottom"
          />
          {{
            limitReached
              ? t(
                  'You have reached the limit of {max} external accounts. Delete one to add another.',
                  { max: MAX_EXTERNAL_ACCOUNTS },
                )
              : t('{used} of {max} external accounts.', {
                  used: list.accounts.length,
                  max: MAX_EXTERNAL_ACCOUNTS,
                })
          }}
        </p>
        <UButton
          :label="t('Add account')"
          icon="i-lucide-plus"
          aria-haspopup="dialog"
          :disabled="limitReached"
          :aria-describedby="list ? 'settings-external-limit' : undefined"
          @click="askAdd"
        />
      </div>
    </div>
    <p>
      {{
        t(
          'Show the calendars of another CalDAV server next to your own, for example from your company or a hosting provider. They are read-only: changes have to be made on their server.',
        )
      }}
    </p>
    <p class="text-sm text-toned">
      <template
        v-for="(part, i) in tparts(
          'Your browser cannot talk to other servers directly, so this app\'s server passes each request on. It does not keep your password. An account with a login needs an {https} address.',
        )"
        :key="i"
      >
        <code v-if="'name' in part">https://</code>
        <template v-else>{{ part.text }}</template>
      </template>
    </p>

    <SettingsErrorAlert
      v-if="accounts.error.value"
      :message="accounts.error.value"
      retryable
      @retry="accounts.reload()"
    />

    <template v-if="list">
      <ul
        v-if="list.accounts.length > 0"
        :aria-label="t('Your external accounts')"
        class="flex flex-col gap-2"
      >
        <li
          v-for="account in list.accounts"
          :key="account.id"
          class="flex flex-col gap-2 rounded-lg border border-default p-3"
        >
          <div class="flex items-start gap-3">
            <span
              class="mt-1 size-4 shrink-0 rounded-full ring-1 ring-black/40 dark:ring-white/60"
              :class="account.color ? '' : 'border border-dashed border-accented bg-default'"
              :style="account.color ? { backgroundColor: account.color } : undefined"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
              <p class="font-medium wrap-anywhere">{{ account.name }}</p>
              <p class="truncate text-sm text-toned" :title="account.url">
                <span class="sr-only">{{ t('Address: ') }}</span
                >{{ account.url }}
              </p>
              <p class="text-sm text-toned wrap-anywhere">
                <span class="sr-only">{{ t('Login: ') }}</span
                >{{
                  account.authMode === 'basic'
                    ? t('User name {name}', { name: account.username ?? '' })
                    : t('No login')
                }}
              </p>
              <p class="sr-only">
                {{
                  t('Colour: {colour}', {
                    colour: account.color ? colorName(account.color) : t('from the server'),
                  })
                }}
              </p>
            </div>
          </div>

          <p
            role="status"
            aria-live="polite"
            class="flex min-h-5 items-start gap-1.5 text-sm"
            :class="STATUS_CLASS[statusOf(account).state]"
          >
            <UIcon
              :name="STATUS_ICON[statusOf(account).state]"
              class="mt-0.5 size-4 shrink-0"
              :class="
                statusOf(account).state === 'checking'
                  ? 'animate-spin motion-reduce:animate-none'
                  : ''
              "
            />
            <span>{{ statusOf(account).text }}</span>
          </p>

          <div class="flex flex-wrap gap-2">
            <UButton
              :label="
                checks.get(account.id)?.state === 'checking'
                  ? t('Checking…')
                  : t('Check connection')
              "
              icon="i-lucide-activity"
              color="neutral"
              variant="outline"
              :aria-label="t('Check connection of {name}', { name: account.name })"
              :aria-busy="checks.get(account.id)?.state === 'checking'"
              @click="checkAccount(account)"
            />
            <UButton
              v-if="needsPassword(account)"
              :label="t('Enter password')"
              icon="i-lucide-key-round"
              color="neutral"
              variant="outline"
              :aria-label="t('Enter the password of {name}', { name: account.name })"
              @click="askPassword(account)"
            />
            <UButton
              :label="t('Edit')"
              icon="i-lucide-pencil"
              color="neutral"
              variant="outline"
              :aria-label="t('Edit {name}', { name: account.name })"
              @click="askEdit(account)"
            />
            <UButton
              :label="t('Delete')"
              icon="i-lucide-trash-2"
              color="neutral"
              variant="outline"
              :class="ERROR_TEXT"
              :aria-label="t('Delete {name}', { name: account.name })"
              @click="askDelete(account)"
            />
          </div>
        </li>
      </ul>
      <p v-else>{{ t('You have no external accounts yet.') }}</p>
    </template>
    <div v-else-if="!accounts.error.value" class="flex flex-col gap-2" role="status">
      <span class="sr-only">{{ t('Loading external accounts') }}</span>
      <USkeleton v-for="row in 2" :key="row" class="h-32 w-full" aria-hidden="true" />
    </div>

    <!-- Adding (no account) and changing one. -->
    <UModal
      :open="formOpen"
      :title="shownForm.title"
      :description="shownForm.description"
      :content="{ onOpenAutoFocus: focusForm, onCloseAutoFocus: formFocus.restore }"
      :ui="{ title: 'wrap-anywhere', description: 'wrap-anywhere' }"
      @update:open="closeForm"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <SettingsErrorAlert v-if="formAlert" :message="formAlert" />
          <!-- Keyed: each opening gets a fresh form, with its own values. -->
          <SettingsExternalAccountForm
            v-if="formOpen"
            :key="formKey"
            ref="form"
            :submit-label="editTarget ? t('Save changes') : t('Add account')"
            cancelable
            :account="editTarget ?? undefined"
            :busy="saving"
            :logins-enabled="loginsEnabled"
            :remembered="editTarget ? seals.isRemembered(editTarget.id) : false"
            :server-errors="formErrors"
            @submit="saveAccount"
            @cancel="closeForm(false)"
          />
        </div>
      </template>
    </UModal>

    <SettingsConfirmModal
      :open="deleteTarget !== null"
      :title="t('Delete “{name}”?', { name: shownDeleteName })"
      :description="
        t(
          'The account is removed from this app, together with the sealed password this browser keeps for it. The calendars on its server are not affected.',
        )
      "
      :confirm-label="t('Delete account')"
      :busy="deleting"
      :error="deleteError"
      :fallback="heading"
      @update:open="closeDelete"
      @confirm="deleteAccount"
    />

    <ExternalPasswordDialog
      :open="passwordTarget !== null"
      :account-name="shownPasswordName"
      :username="shownPasswordUser"
      :remember="shownPasswordRemember"
      :busy="savingPassword"
      :error="passwordError"
      :fallback="heading"
      @update:open="closePassword"
      @submit="savePassword"
    />
  </section>
</template>

<script setup lang="ts">
import { N_, t, tc, tparts } from '~/utils/i18n'
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { MAX_EXTERNAL_ACCOUNTS, type ExternalAccount } from '../../../shared/types/external'
import { useExternalAccess } from '~/composables/useExternalAccess'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { describeExternalSaveError } from '~/utils/external/api-errors'
import { enterPassword, keepResult } from '~/utils/external/credentials'
import { toCreateBody, toUpdateBody, type ExternalFormInput } from '~/utils/external/form'
import { describeCheckFailure, describeCheckOk, rememberNote } from '~/utils/external/status'
import { externalAccountKey, isPasswordError } from '~/utils/live/errors'
import { describeError, parseApiError } from '~/utils/settings/api-errors'
import { createFocusReturn } from '~/utils/settings/focus-return'
import { colorName } from '~/utils/settings/palette'
import { createResource } from '~/utils/settings/resource'
import { ERROR_TEXT, SUCCESS_TEXT } from '~/utils/settings/ui'

type StatusState = 'checking' | 'ok' | 'failed' | 'info'
interface Status {
  state: StatusState
  text: string
  /** A password would cure it. */
  password?: boolean
}
interface FormHandle {
  focusFirst: () => void
}

const STATUS_CLASS: Record<StatusState, string> = {
  checking: 'text-toned',
  ok: SUCCESS_TEXT,
  failed: ERROR_TEXT,
  info: 'text-toned',
}
const STATUS_ICON: Record<StatusState, string> = {
  checking: 'i-lucide-loader-circle',
  ok: 'i-lucide-circle-check',
  failed: 'i-lucide-circle-alert',
  info: 'i-lucide-info',
}

const { api, seals, source } = useExternalAccess()
const notify = useNotify()
const { errors, passwordFor } = useLiveStatus()
const { calendars } = useCalendarState()
// The calendar view reloads its sources when this changes (the live data loader watches it).
const sourcesVersion = useState<number>('calendar-sources-version', () => 0)

const accounts = createResource(async () => {
  const loaded = await api.list()
  // Copies on this device of accounts that are gone are removed; the others are loaded.
  seals.sync(loaded.accounts.map((account) => account.id))
  return loaded
}, N_('load your external accounts'))
const list = accounts.data
onMounted(() => accounts.reload())

const loginsEnabled = computed(() => list.value?.loginsEnabled ?? true)
const limitReached = computed(() => (list.value?.accounts.length ?? 0) >= MAX_EXTERNAL_ACCOUNTS)

const heading = useTemplateRef<HTMLElement>('heading')
const form = useTemplateRef<FormHandle>('form')

function sourcesChanged() {
  sourcesVersion.value++
}

// ---- Adding and changing ---------------------------------------------------------------------

const formOpen = ref(false)
/** The account being changed; null while adding. */
const editTarget = ref<ExternalAccount | null>(null)
/** Each opening gets a fresh form. */
const formKey = ref(0)
const saving = ref(false)
const formErrors = ref<Record<string, string>>()
const formAlert = ref<string | null>(null)
const formFocus = createFocusReturn(() => heading.value)
// Kept while the dialog fades out.
const shownForm = ref({ title: '', description: '' })

function openForm(account: ExternalAccount | null) {
  formFocus.remember()
  formErrors.value = undefined
  formAlert.value = null
  editTarget.value = account
  formKey.value++
  shownForm.value = account
    ? {
        title: t('Edit account'),
        description: t('Change the name, address, login or colour of {name}', {
          name: account.name,
        }),
      }
    : {
        title: t('Add account'),
        description: t('Enter the address of the server and, if it asks for one, the login.'),
      }
  formOpen.value = true
}

function askAdd() {
  if (!limitReached.value) openForm(null)
}

function askEdit(account: ExternalAccount) {
  openForm(account)
}

function closeForm(open: boolean) {
  if (open || saving.value) return
  formOpen.value = false
  editTarget.value = null
}

function focusForm(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  form.value?.focusFirst()
}

async function saveAccount(input: ExternalFormInput) {
  if (saving.value) return
  const target = editTarget.value
  saving.value = true
  formErrors.value = undefined
  formAlert.value = null
  try {
    if (target) {
      const result = await api.update(target.id, toUpdateBody(input))
      const kept = keepResult(seals, result, input.remember)
      const saved = result.account
      accounts.update((current) => ({
        ...current,
        accounts: current.accounts.map((item) => (item.id === saved.id ? saved : item)),
      }))
      // What was checked belonged to the old address and login.
      checks.delete(saved.id)
      notify.done(
        t('Account “{name}” saved.', { name: saved.name }) +
          rememberNote(input.remember && seals.has(saved.id), kept),
      )
    } else {
      const result = await api.create(toCreateBody(input))
      const kept = keepResult(seals, result, input.remember)
      accounts.update((current) => ({
        ...current,
        accounts: [...current.accounts, result.account],
      }))
      notify.done(
        t('Account “{name}” added.', { name: result.account.name }) +
          rememberNote(input.remember && seals.has(result.account.id), kept),
      )
    }
    sourcesChanged()
    formOpen.value = false
    editTarget.value = null
  } catch (cause) {
    // Not logged: the error holds the request, and the request holds the password.
    const failure = describeExternalSaveError(
      cause,
      target ? N_('save the account') : N_('add the account'),
    )
    formErrors.value = failure.byField
    formAlert.value = failure.alert ?? null
    const summary = failure.alert ?? Object.values(failure.byField)[0]
    if (summary) notify.failed(summary)
  } finally {
    saving.value = false
  }
}

// ---- Deleting --------------------------------------------------------------------------------

const deleteTarget = ref<ExternalAccount | null>(null)
const shownDeleteName = ref('')
const deleting = ref(false)
const deleteError = ref<string | null>(null)

function askDelete(account: ExternalAccount) {
  deleteError.value = null
  shownDeleteName.value = account.name
  deleteTarget.value = account
}

function closeDelete(open: boolean) {
  if (!open) deleteTarget.value = null
}

async function deleteAccount() {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await api.remove(target.id)
  } catch (cause) {
    // Already gone is what the person wanted.
    if (parseApiError(cause).kind !== 'not-found') {
      deleteError.value = describeError(cause, N_('delete the account'))
      notify.failed(deleteError.value)
      deleting.value = false
      return
    }
  }
  seals.forget(target.id)
  accounts.update((current) => ({
    ...current,
    accounts: current.accounts.filter((item) => item.id !== target.id),
  }))
  checks.delete(target.id)
  sourcesChanged()
  notify.done(t('Account “{name}” deleted.', { name: target.name }))
  deleteTarget.value = null
  deleting.value = false
}

// ---- Password --------------------------------------------------------------------------------

const passwordTarget = ref<ExternalAccount | null>(null)
const shownPasswordName = ref('')
const shownPasswordUser = ref<string | null>(null)
const shownPasswordRemember = ref(false)
const savingPassword = ref(false)
const passwordError = ref<string | null>(null)

function askPassword(account: ExternalAccount) {
  shownPasswordName.value = account.name
  shownPasswordUser.value = account.username
  shownPasswordRemember.value = seals.isRemembered(account.id)
  passwordError.value = null
  passwordTarget.value = account
}

function closePassword(open: boolean) {
  if (!open && !savingPassword.value) passwordTarget.value = null
}

async function savePassword(input: { password: string; remember: boolean }) {
  const target = passwordTarget.value
  if (!target || savingPassword.value) return
  savingPassword.value = true
  passwordError.value = null
  const outcome = await enterPassword({ api, seals }, target.id, input.password, input.remember)
  savingPassword.value = false
  if (!outcome.ok) {
    passwordError.value = outcome.message
    notify.failed(outcome.message)
    return
  }
  checks.delete(target.id)
  sourcesChanged()
  notify.done(
    t('Password of “{name}” saved.', { name: target.name }) +
      rememberNote(input.remember, outcome.remembered),
  )
  passwordTarget.value = null
}

// ---- Status and checking ---------------------------------------------------------------------

const checks = reactive(new Map<number, Status>())

async function checkAccount(account: ExternalAccount) {
  if (checks.get(account.id)?.state === 'checking') return
  checks.set(account.id, { state: 'checking', text: t('Checking the connection…') })
  try {
    const found = await source.listCalendars(account)
    checks.set(account.id, {
      state: found.length > 0 ? 'ok' : 'failed',
      text: describeCheckOk(found.length),
    })
  } catch (cause) {
    checks.set(account.id, {
      state: 'failed',
      text: t('Check failed: {reason}', { reason: describeCheckFailure(cause) }),
      password: isPasswordError(cause),
    })
  }
}

/** What to tell about an account: a check the person ran, else what the calendar view found. */
function statusOf(account: ExternalAccount): Status {
  const check = checks.get(account.id)
  if (check) return check
  const problem = errors.value[externalAccountKey(account.id)]
  if (problem) {
    return {
      state: 'failed',
      text: t('{problem}. The problems list in the sidebar has more.', { problem }),
    }
  }
  if (account.authMode === 'basic' && !seals.has(account.id)) {
    return { state: 'info', text: t('This browser has no password for the account yet.') }
  }
  const shown = calendars.value.filter((c) => c.caldavAccountId === String(account.id)).length
  return shown > 0
    ? {
        state: 'ok',
        text: tc('Connected: {count} calendar shown. | Connected: {count} calendars shown.', shown),
      }
    : { state: 'info', text: t('Not checked yet.') }
}

/** A password is missing, or the server refused the one that was used. */
function needsPassword(account: ExternalAccount): boolean {
  if (account.authMode !== 'basic') return false
  return (
    !seals.has(account.id) ||
    checks.get(account.id)?.password === true ||
    externalAccountKey(account.id) in passwordFor.value
  )
}
</script>
