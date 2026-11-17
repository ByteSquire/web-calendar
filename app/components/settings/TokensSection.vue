<!--
  App tokens (FR-30, FR-31): the passwords for calendar apps that cannot do single sign-on
  (Thunderbird, DAVx5, iOS Calendar). "New token", beside the heading, opens a dialog with the
  label; after creating, the same dialog shows the secret once (with Copy and the expiry) until
  Done, Escape or its close button. The secret lives in this component only (never in shared
  state, never in storage) and is dropped when the dialog closes and when the page is left. At the
  limit the button is disabled; the sentence beside it, there from the start, says how many are in
  use and why. A revoke is told in a toast, and a failed request in its dialog and in a toast, so
  the list never moves.
-->
<template>
  <section aria-labelledby="settings-tokens" class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 id="settings-tokens" ref="heading" tabindex="-1" class="text-lg font-semibold">
        {{ t('App tokens') }}
      </h2>
      <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <p v-if="list" id="settings-token-limit" class="text-sm text-toned">
          <UIcon
            v-if="limit.reached"
            name="i-lucide-info"
            class="mr-1 inline size-4 align-text-bottom"
          />
          {{ limit.message }}
        </p>
        <UButton
          :label="t('New token')"
          icon="i-lucide-plus"
          aria-haspopup="dialog"
          :disabled="limit.reached"
          :aria-describedby="list ? 'settings-token-limit' : undefined"
          @click="openDialog"
        />
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <p>
        <template
          v-for="(part, i) in tparts(
            'Calendar apps such as Thunderbird, DAVx5 or iOS Calendar cannot use single sign-on. Create an app token for each app and enter it as the {password}.',
          )"
          :key="i"
        >
          <strong v-if="'name' in part">{{ t('password') }}</strong>
          <template v-else>{{ part.text }}</template>
        </template>
      </p>
      <p class="text-sm text-toned" data-signin-window>
        {{
          t(
            'An app token stops working if you do not sign in to this app for {days}. Signing in again makes it work again.',
            { days: tc('{count} day | {count} days', windowDays) },
          )
        }}
      </p>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt class="text-toned">{{ t('Server address') }}</dt>
        <dd>
          <code class="break-all select-all">{{ serverAddress }}</code>
          <span class="mt-1 block text-sm text-toned">
            <template
              v-for="(part, i) in tparts(
                'Apps that find the server themselves start from {address}.',
              )"
              :key="i"
            >
              <code v-if="'name' in part" class="break-all select-all">{{ discoveryAddress }}</code>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
        </dd>
        <dt class="text-toned">{{ t('User name') }}</dt>
        <dd>
          <code v-if="username" class="break-all select-all">{{ username }}</code>
          <span v-else>{{ t('Your user name (see Account)') }}</span>
        </dd>
        <dt class="text-toned">{{ t('Password') }}</dt>
        <dd>{{ t('An app token from this page') }}</dd>
      </dl>
    </div>

    <SettingsErrorAlert
      v-if="tokens.error.value"
      :message="tokens.error.value"
      retryable
      @retry="tokens.reload()"
    />

    <template v-if="list">
      <div v-if="list.tokens.length > 0" class="flex justify-end">
        <UButton
          :label="t('Revoke all')"
          icon="i-lucide-shield-off"
          color="neutral"
          variant="outline"
          :class="ERROR_TEXT"
          @click="askRevokeAll"
        />
      </div>
      <ul
        v-if="list.tokens.length > 0"
        :aria-label="t('Your app tokens')"
        class="flex flex-col gap-2"
      >
        <li
          v-for="token in list.tokens"
          :key="token.id"
          class="flex flex-col gap-2 rounded-lg border border-default p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <p class="flex flex-wrap items-center gap-2 font-medium">
              <span class="wrap-anywhere">{{ token.label }}</span>
              <UBadge
                v-if="token.expired"
                :label="t('Expired')"
                icon="i-lucide-clock-alert"
                color="neutral"
                variant="outline"
              />
            </p>
            <dl class="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-sm text-toned">
              <dt>{{ t('Created') }}</dt>
              <dd>
                <time :datetime="token.createdAt">{{
                  formatDateTime(token.createdAt, displayZone)
                }}</time>
              </dd>
              <dt>{{ t('Expires') }}</dt>
              <dd>
                <time :datetime="token.expiresAt">{{
                  formatDateTime(token.expiresAt, displayZone)
                }}</time>
              </dd>
              <dt>{{ t('Last used') }}</dt>
              <dd>
                <time v-if="token.lastUsedAt" :datetime="token.lastUsedAt">{{
                  formatDateTime(token.lastUsedAt, displayZone)
                }}</time>
                <template v-else>{{ t('Never') }}</template>
              </dd>
            </dl>
          </div>
          <UButton
            :label="t('Revoke')"
            icon="i-lucide-trash-2"
            color="neutral"
            variant="outline"
            :aria-label="t('Revoke token {label}', { label: token.label })"
            :class="ERROR_TEXT"
            @click="askRevoke(token)"
          />
        </li>
      </ul>
      <p v-else>{{ t('You have no app tokens yet.') }}</p>
    </template>
    <div v-else-if="!tokens.error.value" class="flex flex-col gap-2" role="status">
      <span class="sr-only">{{ t('Loading app tokens') }}</span>
      <USkeleton v-for="row in 2" :key="row" class="h-24 w-full" aria-hidden="true" />
    </div>

    <!-- The label first; after creating, the secret, once. -->
    <UModal
      :open="dialogOpen"
      :title="shownHeader.title"
      :description="shownHeader.description"
      :content="{ onOpenAutoFocus: focusLabel, onCloseAutoFocus: dialogFocus.restore }"
      :ui="{ title: 'wrap-anywhere', description: 'wrap-anywhere' }"
      @update:open="onDialogOpenChange"
    >
      <template #body>
        <div v-if="created" class="flex flex-col gap-3">
          <UAlert
            color="neutral"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('Copy it now')"
            :description="
              t(
                'This token is shown only once. After you press Done it cannot be shown again; if you lose it, revoke it and create a new one.',
              )
            "
          />
          <UFormField :label="t('Token')" name="new-token">
            <div class="flex gap-2">
              <UInput
                ref="secretInput"
                :model-value="created.token"
                readonly
                autocomplete="off"
                spellcheck="false"
                class="min-w-0 flex-1"
                :ui="{ base: 'font-mono' }"
                @focus="selectSecret"
              />
              <UButton
                :label="t('Copy')"
                icon="i-lucide-copy"
                color="neutral"
                @click="copySecret"
              />
            </div>
          </UFormField>
          <!-- Present from the start and only its text changes, so screen readers announce it. -->
          <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ copyStatus }}</p>
        </div>

        <!-- Not while the dialog fades out: the secret is gone by then, the form is not wanted. -->
        <form
          v-else-if="dialogOpen"
          :id="formId"
          novalidate
          class="flex flex-col gap-3"
          @submit.prevent="createToken"
        >
          <UFormField
            :label="t('Label')"
            name="label"
            required
            :help="t('Which app is this token for? Up to 64 characters.')"
            :error="labelError"
            :ui="FIELD_UI"
          >
            <UInput ref="labelInput" v-model="label" autocomplete="off" class="w-full" />
          </UFormField>
          <SettingsErrorAlert v-if="createAlert" :message="createAlert" />
        </form>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton v-if="created" :label="t('Done')" @click="closeDialog" />
          <template v-else>
            <UButton
              :label="t('Cancel')"
              color="neutral"
              variant="outline"
              :disabled="creating"
              @click="closeDialog"
            />
            <UButton
              type="submit"
              :form="formId"
              :label="creating ? t('Creating…') : t('Create token')"
              icon="i-lucide-key-round"
              :aria-busy="creating"
            />
          </template>
        </div>
      </template>
    </UModal>

    <SettingsConfirmModal
      :open="revokeTarget !== null"
      :title="t('Revoke token “{label}”?', { label: shownRevokeLabel })"
      :description="t('Apps that use this token can no longer sign in. This cannot be undone.')"
      :confirm-label="t('Revoke token')"
      :busy="revoking"
      :error="revokeError"
      :fallback="heading"
      @update:open="closeRevoke"
      @confirm="revokeToken"
    />

    <SettingsConfirmModal
      :open="revokeAllOpen"
      :title="t('Revoke all app tokens?')"
      :description="
        t(
          'Every calendar app that uses one of your tokens is signed out at once. This cannot be undone.',
        )
      "
      :confirm-label="t('Revoke all')"
      :busy="revokingAll"
      :error="revokeAllError"
      :fallback="heading"
      @update:open="closeRevokeAll"
      @confirm="revokeAllTokens"
    />
  </section>
</template>

<script setup lang="ts">
import { useAuthFetch } from '~/composables/useAuthFetch'
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { N_, t, tc, tparts } from '~/utils/i18n'
import { describeError, describeTokenCreateError, parseApiError } from '~/utils/settings/api-errors'
import { createFocusReturn } from '~/utils/settings/focus-return'
import { formatDate, formatDateTime } from '~/utils/settings/format'
import { createResource } from '~/utils/settings/resource'
import { caldavAddress, caldavDiscoveryAddress, tokenLimit } from '~/utils/settings/tokens'
import type { CreatedToken, TokenList, TokenListItem } from '~/utils/settings/types'
import { ERROR_TEXT, FIELD_UI } from '~/utils/settings/ui'
import { validateTokenLabel } from '~/utils/settings/validation'

defineProps<{
  /** The user name to enter in the calendar app (`/api/me`); null while it is not known. */
  username: string | null
}>()

const api = useAuthFetch()
const notify = useNotify()
const serverConfig = useServerConfigState()
/** How long after the last sign-in a token works (NUXT_SIGNIN_WINDOW_DAYS); 30 until it is known. */
const windowDays = computed(() => serverConfig.value?.signinWindowDays ?? 30)
const displayZone = useDisplayTimeZone()
const origin = useRequestURL().origin
const serverAddress = caldavAddress(origin)
const discoveryAddress = caldavDiscoveryAddress(origin)

const tokens = createResource(() => api<TokenList>('/api/app-tokens'), N_('load your app tokens'))
const list = tokens.data
const limit = computed(() => tokenLimit(list.value))
onMounted(() => tokens.reload())

const heading = useTemplateRef<HTMLElement>('heading')
const labelInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('labelInput')
const secretInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('secretInput')
const formId = `${useId()}-token-form`

// ---- The dialog: creating a token, then its secret -------------------------------------------

const dialogOpen = ref(false)
const dialogFocus = createFocusReturn(() => heading.value)
const label = ref('')
const submitted = ref(false)
const serverLabelError = ref<{ forLabel: string; message: string } | null>(null)
const createAlert = ref<string | null>(null)
const creating = ref(false)
/** The new token with its secret, until the dialog closes. */
const created = ref<CreatedToken | null>(null)
const copyStatus = ref('')

const labelError = computed(
  () =>
    (submitted.value ? validateTokenLabel(label.value) : undefined) ??
    (serverLabelError.value?.forLabel === label.value ? serverLabelError.value.message : undefined),
)

const header = computed(() =>
  created.value
    ? {
        title: t('New token for “{label}”', { label: created.value.label }),
        description: t('Expires on {date}.', {
          date: formatDate(created.value.expiresAt, displayZone.value),
        }),
      }
    : { title: t('New token'), description: t('Create one token for each calendar app.') },
)
// Kept while the dialog fades out, after the secret (and with it the title) was dropped.
const shownHeader = ref(header.value)
watch(header, (value) => {
  if (dialogOpen.value) shownHeader.value = value
})

function resetDialog() {
  label.value = ''
  submitted.value = false
  serverLabelError.value = null
  createAlert.value = null
  created.value = null
  copyStatus.value = ''
}

function openDialog() {
  if (limit.value.reached) return
  dialogFocus.remember()
  resetDialog()
  shownHeader.value = header.value
  dialogOpen.value = true
}

function closeDialog() {
  // A request in flight cannot be taken back: stay open until it has answered.
  if (creating.value) return
  dialogOpen.value = false
  // The secret goes with the dialog, whichever way it was closed.
  resetDialog()
}

function onDialogOpenChange(open: boolean) {
  if (!open) closeDialog()
}

function focusLabel(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  labelInput.value?.inputRef?.focus()
}

async function createToken() {
  if (creating.value) return
  submitted.value = true
  createAlert.value = null
  serverLabelError.value = null
  if (validateTokenLabel(label.value)) {
    await nextTick()
    labelInput.value?.inputRef?.focus()
    return
  }

  creating.value = true
  try {
    created.value = await api<CreatedToken>('/api/app-tokens', {
      method: 'POST',
      body: { label: label.value.trim() },
    })
    copyStatus.value = ''
    void tokens.reload()
    await nextTick()
    // The secret is selected, so Ctrl+C copies it at once.
    secretInput.value?.inputRef?.focus()
  } catch (cause) {
    const failure = describeTokenCreateError(cause)
    if (failure.label) serverLabelError.value = { forLabel: label.value, message: failure.label }
    createAlert.value = failure.alert ?? null
    const summary = failure.alert ?? failure.label
    if (summary) notify.failed(summary)
    if (failure.limitReached) void tokens.reload()
    await nextTick()
    if (failure.label) labelInput.value?.inputRef?.focus()
  } finally {
    creating.value = false
  }
}

function selectSecret(event: FocusEvent) {
  if (event.target instanceof HTMLInputElement) event.target.select()
}

async function copySecret() {
  const input = secretInput.value?.inputRef
  const secret = created.value?.token
  if (!secret) return
  // Empty first: the same sentence twice in a row is only announced if the text changed in between.
  copyStatus.value = ''
  await nextTick()
  try {
    await navigator.clipboard.writeText(secret)
    copyStatus.value = t('Copied to the clipboard.')
  } catch {
    // No clipboard access (insecure page, denied): leave the token selected for the keyboard.
    input?.focus()
    copyStatus.value = t(
      'Could not copy automatically. The token is selected: press Ctrl+C to copy it.',
    )
  }
}

onBeforeUnmount(() => {
  created.value = null
})

// ---- Revoking a token -------------------------------------------------------------------------

const revokeTarget = ref<TokenListItem | null>(null)
// Keeps the title while the dialog fades out after the token was removed.
const shownRevokeLabel = ref('')
const revoking = ref(false)
const revokeError = ref<string | null>(null)

function askRevoke(token: TokenListItem) {
  revokeError.value = null
  shownRevokeLabel.value = token.label
  revokeTarget.value = token
}

function closeRevoke(open: boolean) {
  if (!open) revokeTarget.value = null
}

async function revokeToken() {
  const target = revokeTarget.value
  if (!target || revoking.value) return
  revoking.value = true
  revokeError.value = null
  try {
    await api(`/api/app-tokens/${target.id}`, { method: 'DELETE' })
  } catch (cause) {
    // A token that is already gone is what the person wanted.
    if (parseApiError(cause).kind !== 'not-found') {
      revokeError.value = describeError(cause, N_('revoke the token'))
      notify.failed(revokeError.value)
      revoking.value = false
      return
    }
  }
  tokens.update((current) => ({
    ...current,
    tokens: current.tokens.filter((token) => token.id !== target.id),
  }))
  notify.done(t('Token “{label}” revoked.', { label: target.label }))
  revokeTarget.value = null
  revoking.value = false
}

// ---- Revoking every token (security review 2026-11-01, finding 3) ----------------------------

const revokeAllOpen = ref(false)
const revokingAll = ref(false)
const revokeAllError = ref<string | null>(null)

function askRevokeAll() {
  revokeAllError.value = null
  revokeAllOpen.value = true
}

function closeRevokeAll(open: boolean) {
  if (!open) revokeAllOpen.value = false
}

async function revokeAllTokens() {
  if (revokingAll.value) return
  revokingAll.value = true
  revokeAllError.value = null
  try {
    await api('/api/app-tokens', { method: 'DELETE' })
  } catch (cause) {
    revokeAllError.value = describeError(cause, N_('revoke your app tokens'))
    notify.failed(revokeAllError.value)
    revokingAll.value = false
    return
  }
  tokens.update((current) => ({ ...current, tokens: [] }))
  notify.done(t('All app tokens revoked.'))
  revokeAllOpen.value = false
  revokingAll.value = false
}
</script>
