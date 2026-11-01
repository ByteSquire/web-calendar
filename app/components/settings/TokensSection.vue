<!--
  App tokens (FR-30, FR-31): the passwords for calendar apps that cannot do single sign-on
  (Thunderbird, DAVx5, iOS Calendar). The secret of a new token is shown once, in a panel that
  replaces the form until "Done"; it lives in this component only (never in shared state, never
  in storage) and is dropped on Done and when the page is left.
-->
<template>
  <section aria-labelledby="settings-tokens" class="flex flex-col gap-4">
    <h2 id="settings-tokens" ref="heading" tabindex="-1" class="text-lg font-semibold">
      App tokens
    </h2>

    <div class="flex flex-col gap-2">
      <p>
        Calendar apps such as Thunderbird, DAVx5 or iOS Calendar cannot use single sign-on. Create
        an app token for each app and enter it as the <strong>password</strong>.
      </p>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt class="text-toned">Server address</dt>
        <dd>
          <code class="break-all select-all">{{ serverAddress }}</code>
          <span class="mt-1 block text-sm text-toned">
            Apps that find the server themselves start from
            <code class="break-all select-all">{{ discoveryAddress }}</code
            >.
          </span>
        </dd>
        <dt class="text-toned">User name</dt>
        <dd>
          <code v-if="username" class="break-all select-all">{{ username }}</code>
          <span v-else>Your user name (see Account)</span>
        </dd>
        <dt class="text-toned">Password</dt>
        <dd>An app token from this page</dd>
      </dl>
    </div>

    <!-- The secret, once. -->
    <div
      v-if="created"
      role="group"
      aria-labelledby="settings-token-created"
      class="flex flex-col gap-3 rounded-lg border-2 border-accented p-4"
    >
      <h3 id="settings-token-created" class="font-semibold wrap-anywhere">
        New token for “{{ created.label }}”
      </h3>
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Copy it now"
        description="This token is shown only once. After you press Done it cannot be shown again; if you lose it, revoke it and create a new one."
      />
      <UFormField label="Token" name="new-token">
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
          <UButton label="Copy" icon="i-lucide-copy" color="neutral" @click="copySecret" />
        </div>
      </UFormField>
      <!-- Present from the start and only its text changes, so screen readers announce it. -->
      <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ copyStatus }}</p>
      <p class="text-sm text-toned">Expires on {{ formatDate(created.expiresAt, displayZone) }}.</p>
      <div>
        <UButton label="Done" @click="dismissCreated" />
      </div>
    </div>

    <form v-else novalidate class="flex flex-col gap-3" @submit.prevent="createToken">
      <UFormField
        label="Label"
        name="label"
        required
        :help="limit.reached ? undefined : 'Which app is this token for? Up to 64 characters.'"
        :error="labelError"
        :ui="FIELD_UI"
      >
        <UInput
          ref="labelInput"
          v-model="label"
          autocomplete="off"
          :disabled="limit.reached"
          class="w-full"
        />
      </UFormField>
      <SettingsErrorAlert v-if="createAlert" :message="createAlert" />
      <p v-if="limit.reached" id="settings-token-limit" class="text-sm font-medium">
        <UIcon name="i-lucide-info" class="mr-1 inline size-4 align-text-bottom" />
        {{ limit.message }}
      </p>
      <div>
        <UButton
          type="submit"
          :label="creating ? 'Creating…' : 'Create token'"
          icon="i-lucide-key-round"
          :disabled="limit.reached"
          :aria-busy="creating"
          :aria-describedby="limit.reached ? 'settings-token-limit' : undefined"
        />
      </div>
    </form>

    <!-- Announces what happened to a token (revoked, ...). -->
    <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>

    <SettingsErrorAlert
      v-if="tokens.error.value"
      :message="tokens.error.value"
      retryable
      @retry="tokens.reload()"
    />

    <template v-if="list">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p v-if="!limit.reached" class="text-sm text-toned">{{ limit.message }}</p>
        <UButton
          v-if="list.tokens.length > 0"
          label="Revoke all"
          icon="i-lucide-shield-off"
          color="neutral"
          variant="outline"
          :class="ERROR_TEXT"
          @click="askRevokeAll"
        />
      </div>
      <ul v-if="list.tokens.length > 0" aria-label="Your app tokens" class="flex flex-col gap-2">
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
                label="Expired"
                icon="i-lucide-clock-alert"
                color="neutral"
                variant="outline"
              />
            </p>
            <dl class="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-sm text-toned">
              <dt>Created</dt>
              <dd>
                <time :datetime="token.createdAt">{{
                  formatDateTime(token.createdAt, displayZone)
                }}</time>
              </dd>
              <dt>Expires</dt>
              <dd>
                <time :datetime="token.expiresAt">{{
                  formatDateTime(token.expiresAt, displayZone)
                }}</time>
              </dd>
              <dt>Last used</dt>
              <dd>
                <time v-if="token.lastUsedAt" :datetime="token.lastUsedAt">{{
                  formatDateTime(token.lastUsedAt, displayZone)
                }}</time>
                <template v-else>Never</template>
              </dd>
            </dl>
          </div>
          <UButton
            label="Revoke"
            icon="i-lucide-trash-2"
            color="neutral"
            variant="outline"
            :aria-label="`Revoke token ${token.label}`"
            :class="ERROR_TEXT"
            @click="askRevoke(token)"
          />
        </li>
      </ul>
      <p v-else>You have no app tokens yet.</p>
    </template>
    <div v-else-if="!tokens.error.value" class="flex flex-col gap-2" role="status">
      <span class="sr-only">Loading app tokens</span>
      <USkeleton v-for="row in 2" :key="row" class="h-24 w-full" aria-hidden="true" />
    </div>

    <SettingsConfirmModal
      :open="revokeTarget !== null"
      :title="`Revoke token “${shownRevokeLabel}”?`"
      description="Apps that use this token can no longer sign in. This cannot be undone."
      confirm-label="Revoke token"
      :busy="revoking"
      :error="revokeError"
      :fallback="heading"
      @update:open="closeRevoke"
      @confirm="revokeToken"
    />

    <SettingsConfirmModal
      :open="revokeAllOpen"
      title="Revoke all app tokens?"
      description="Every calendar app that uses one of your tokens is signed out at once. This cannot be undone."
      confirm-label="Revoke all"
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
import { describeError, describeTokenCreateError, parseApiError } from '~/utils/settings/api-errors'
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
const displayZone = useDisplayTimeZone()
const origin = useRequestURL().origin
const serverAddress = caldavAddress(origin)
const discoveryAddress = caldavDiscoveryAddress(origin)

const tokens = createResource(() => api<TokenList>('/api/app-tokens'), 'load your app tokens')
const list = tokens.data
const limit = computed(() => tokenLimit(list.value))
onMounted(() => tokens.reload())

const heading = useTemplateRef<HTMLElement>('heading')
const labelInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('labelInput')
const secretInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('secretInput')

const notice = ref('')

// ---- Creating a token -------------------------------------------------------------------------

const label = ref('')
const submitted = ref(false)
const serverLabelError = ref<{ forLabel: string; message: string } | null>(null)
const createAlert = ref<string | null>(null)
const creating = ref(false)
/** The new token with its secret, until Done. */
const created = ref<CreatedToken | null>(null)
const copyStatus = ref('')

const labelError = computed(
  () =>
    (submitted.value ? validateTokenLabel(label.value) : undefined) ??
    (serverLabelError.value?.forLabel === label.value ? serverLabelError.value.message : undefined),
)

async function createToken() {
  if (creating.value) return
  submitted.value = true
  createAlert.value = null
  serverLabelError.value = null
  notice.value = ''
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
    label.value = ''
    submitted.value = false
    copyStatus.value = ''
    void tokens.reload()
    await nextTick()
    // The secret is selected, so Ctrl+C copies it at once.
    secretInput.value?.inputRef?.focus()
  } catch (cause) {
    const failure = describeTokenCreateError(cause)
    if (failure.label) serverLabelError.value = { forLabel: label.value, message: failure.label }
    createAlert.value = failure.alert ?? null
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
    copyStatus.value = 'Copied to the clipboard.'
  } catch {
    // No clipboard access (insecure page, denied): leave the token selected for the keyboard.
    input?.focus()
    copyStatus.value =
      'Could not copy automatically. The token is selected: press Ctrl+C to copy it.'
  }
}

async function dismissCreated() {
  created.value = null
  copyStatus.value = ''
  await nextTick()
  labelInput.value?.inputRef?.focus()
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
      revokeError.value = describeError(cause, 'revoke the token')
      revoking.value = false
      return
    }
  }
  tokens.update((current) => ({
    ...current,
    tokens: current.tokens.filter((token) => token.id !== target.id),
  }))
  notice.value = `Token “${target.label}” revoked.`
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
    revokeAllError.value = describeError(cause, 'revoke your app tokens')
    revokingAll.value = false
    return
  }
  tokens.update((current) => ({ ...current, tokens: [] }))
  notice.value = 'All app tokens revoked.'
  revokeAllOpen.value = false
  revokingAll.value = false
}
</script>
