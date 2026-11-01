<!--
  iCal subscriptions (FR-7, the address half; the file half is ImportSection.vue): read-only
  calendars from an .ics address. The server fetches the file (browsers cannot read arbitrary
  addresses), so "Check" asks it to try and reports the outcome. Shared subscriptions (offered to
  everybody) are listed read-only. Every change bumps `calendar-sources-version`, which the
  calendar view watches to load its sources again.
-->
<template>
  <section aria-labelledby="settings-subscriptions" class="flex flex-col gap-4">
    <h2 id="settings-subscriptions" ref="heading" tabindex="-1" class="text-lg font-semibold">
      iCal subscriptions
    </h2>
    <p>
      Show a calendar from a web address (an <code>.ics</code> file) next to your own calendars. It
      is read-only: changes have to be made at its source. If you have a file instead of an address,
      you can import its events into one of your calendars.
    </p>

    <div class="flex flex-col gap-3 rounded-lg border border-default p-4">
      <h3 class="font-semibold">Add a subscription</h3>
      <SettingsErrorAlert v-if="addAlert" :message="addAlert" />
      <SettingsSubscriptionForm
        ref="addForm"
        submit-label="Add subscription"
        :busy="adding"
        :server-errors="addErrors"
        @submit="addSubscription"
      />
    </div>

    <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>

    <SettingsErrorAlert
      v-if="subscriptions.error.value"
      :message="subscriptions.error.value"
      retryable
      @retry="subscriptions.reload()"
    />

    <template v-if="list">
      <ul
        v-if="list.subscriptions.length > 0"
        aria-label="Your calendar subscriptions"
        class="flex flex-col gap-2"
      >
        <li
          v-for="subscription in list.subscriptions"
          :key="subscription.id"
          class="flex flex-col gap-2 rounded-lg border border-default p-3"
        >
          <div class="flex items-start gap-3">
            <span
              class="mt-1 size-4 shrink-0 rounded-full ring-1 ring-black/40 dark:ring-white/60"
              :class="subscription.color ? '' : 'border border-dashed border-accented bg-default'"
              :style="subscription.color ? { backgroundColor: subscription.color } : undefined"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 font-medium">
                <span class="wrap-anywhere">{{ subscription.name }}</span>
                <UBadge
                  v-if="subscription.shared"
                  label="Shared"
                  icon="i-lucide-users"
                  color="neutral"
                  variant="outline"
                />
              </p>
              <p class="truncate text-sm text-toned" :title="subscription.url">
                <span class="sr-only">Address: </span>{{ subscription.url }}
              </p>
              <p class="sr-only">Colour: {{ colorName(subscription.color) }}</p>
              <p v-if="subscription.shared" class="text-sm text-toned">
                Shared with everyone. Only an administrator can change it.
              </p>
            </div>
          </div>

          <p
            role="status"
            aria-live="polite"
            class="flex items-start gap-1.5 text-sm"
            :class="checkClass(subscription.id)"
          >
            <template v-if="checks.has(subscription.id)">
              <UIcon
                :name="checkIcon(subscription.id)"
                class="mt-0.5 size-4 shrink-0"
                :class="
                  checks.get(subscription.id)!.state === 'checking'
                    ? 'animate-spin motion-reduce:animate-none'
                    : ''
                "
              />
              <span>{{ checks.get(subscription.id)!.text }}</span>
            </template>
          </p>

          <div class="flex flex-wrap gap-2">
            <UButton
              :label="checks.get(subscription.id)?.state === 'checking' ? 'Checking…' : 'Check'"
              icon="i-lucide-activity"
              color="neutral"
              variant="outline"
              :aria-label="`Check ${subscription.name}`"
              :aria-busy="checks.get(subscription.id)?.state === 'checking'"
              @click="checkSubscription(subscription)"
            />
            <template v-if="!subscription.shared">
              <UButton
                label="Edit"
                icon="i-lucide-pencil"
                color="neutral"
                variant="outline"
                :aria-label="`Edit ${subscription.name}`"
                @click="askEdit(subscription)"
              />
              <UButton
                label="Delete"
                icon="i-lucide-trash-2"
                color="neutral"
                variant="outline"
                :class="ERROR_TEXT"
                :aria-label="`Delete ${subscription.name}`"
                @click="askDelete(subscription)"
              />
            </template>
          </div>
        </li>
      </ul>
      <p v-else>You have no calendar subscriptions yet.</p>
    </template>
    <div v-else-if="!subscriptions.error.value" class="flex flex-col gap-2" role="status">
      <span class="sr-only">Loading calendar subscriptions</span>
      <USkeleton v-for="row in 2" :key="row" class="h-28 w-full" aria-hidden="true" />
    </div>

    <UModal
      :open="editTarget !== null"
      title="Edit subscription"
      :description="`Change the name, address or colour of ${shownEditName}`"
      :content="{ onOpenAutoFocus: focusEditForm, onCloseAutoFocus: editFocus.restore }"
      :ui="{ title: 'wrap-anywhere', description: 'wrap-anywhere' }"
      @update:open="closeEdit"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <SettingsErrorAlert v-if="editAlert" :message="editAlert" />
          <!-- Keyed: each subscription gets a fresh form, with its own values. -->
          <SettingsSubscriptionForm
            v-if="editTarget"
            :key="editTarget.id"
            ref="editForm"
            submit-label="Save changes"
            cancelable
            :subscription="editTarget"
            :busy="saving"
            :server-errors="editErrors"
            @submit="saveSubscription"
            @cancel="closeEdit(false)"
          />
        </div>
      </template>
    </UModal>

    <SettingsConfirmModal
      :open="deleteTarget !== null"
      :title="`Delete “${shownDeleteName}”?`"
      description="The calendar is removed from your subscriptions. The calendar at its source is not affected."
      confirm-label="Delete subscription"
      :busy="deleting"
      :error="deleteError"
      :fallback="heading"
      @update:open="closeDelete"
      @confirm="deleteSubscription"
    />
  </section>
</template>

<script setup lang="ts">
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { useAuthFetch } from '~/composables/useAuthFetch'
import {
  describeError,
  describeSubscriptionSaveError,
  parseApiError,
} from '~/utils/settings/api-errors'
import { describeCheckError, describeCheckSuccess } from '~/utils/settings/check'
import { createFocusReturn } from '~/utils/settings/focus-return'
import { colorName } from '~/utils/settings/palette'
import { createResource } from '~/utils/settings/resource'
import type { Subscription, SubscriptionInput } from '~/utils/settings/types'
import { ERROR_TEXT, SUCCESS_TEXT } from '~/utils/settings/ui'

interface SubscriptionList {
  subscriptions: Subscription[]
}
interface CheckResult {
  state: 'checking' | 'ok' | 'failed'
  text: string
}
interface FormHandle {
  focusFirst: () => void
  reset: () => void
}

const api = useAuthFetch()
// The calendar view reloads its sources when this changes (the live data loader watches it).
const sourcesVersion = useState<number>('calendar-sources-version', () => 0)

const subscriptions = createResource(
  () => api<SubscriptionList>('/api/ical-subscriptions'),
  'load your calendar subscriptions',
)
const list = subscriptions.data
onMounted(() => subscriptions.reload())

const heading = useTemplateRef<HTMLElement>('heading')
const addForm = useTemplateRef<FormHandle>('addForm')
const editForm = useTemplateRef<FormHandle>('editForm')
const notice = ref('')

function sourcesChanged() {
  sourcesVersion.value++
}

// ---- Adding ----------------------------------------------------------------------------------

const adding = ref(false)
const addErrors = ref<Record<string, string>>()
const addAlert = ref<string | null>(null)

async function addSubscription(input: SubscriptionInput) {
  if (adding.value) return
  adding.value = true
  addErrors.value = undefined
  addAlert.value = null
  notice.value = ''
  try {
    const created = await api<Subscription>('/api/ical-subscriptions', {
      method: 'POST',
      body: toBody(input),
    })
    subscriptions.update((current) => ({
      ...current,
      subscriptions: [...current.subscriptions, created],
    }))
    sourcesChanged()
    addForm.value?.reset()
    notice.value = `Subscription “${created.name}” added.`
  } catch (cause) {
    const failure = describeSubscriptionSaveError(cause, 'add the subscription')
    addErrors.value = failure.byField
    addAlert.value = failure.alert ?? null
  } finally {
    adding.value = false
  }
}

/** '' (the form's "default colour") is stored as no colour. */
function toBody(input: SubscriptionInput) {
  return { name: input.name, url: input.url, color: input.color || null }
}

// ---- Changing --------------------------------------------------------------------------------

const editTarget = ref<Subscription | null>(null)
// Keeps the name while the dialog fades out.
const shownEditName = ref('')
const saving = ref(false)
const editErrors = ref<Record<string, string>>()
const editAlert = ref<string | null>(null)
const editFocus = createFocusReturn(() => heading.value)

function askEdit(subscription: Subscription) {
  editFocus.remember()
  editErrors.value = undefined
  editAlert.value = null
  shownEditName.value = subscription.name
  editTarget.value = subscription
}

function closeEdit(open: boolean) {
  if (open || saving.value) return
  editTarget.value = null
}

function focusEditForm(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  editForm.value?.focusFirst()
}

async function saveSubscription(input: SubscriptionInput) {
  const target = editTarget.value
  if (!target || saving.value) return
  saving.value = true
  editErrors.value = undefined
  editAlert.value = null
  try {
    const saved = await api<Subscription>(`/api/ical-subscriptions/${target.id}`, {
      method: 'PUT',
      body: toBody(input),
    })
    subscriptions.update((current) => ({
      ...current,
      subscriptions: current.subscriptions.map((item) => (item.id === saved.id ? saved : item)),
    }))
    // What was checked belonged to the old address.
    if (saved.url !== target.url) checks.delete(saved.id)
    sourcesChanged()
    notice.value = `Subscription “${saved.name}” saved.`
    editTarget.value = null
  } catch (cause) {
    const failure = describeSubscriptionSaveError(cause, 'save the subscription')
    editErrors.value = failure.byField
    editAlert.value = failure.alert ?? null
  } finally {
    saving.value = false
  }
}

// ---- Deleting --------------------------------------------------------------------------------

const deleteTarget = ref<Subscription | null>(null)
const shownDeleteName = ref('')
const deleting = ref(false)
const deleteError = ref<string | null>(null)

function askDelete(subscription: Subscription) {
  deleteError.value = null
  shownDeleteName.value = subscription.name
  deleteTarget.value = subscription
}

function closeDelete(open: boolean) {
  if (!open) deleteTarget.value = null
}

async function deleteSubscription() {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  deleteError.value = null
  try {
    await api(`/api/ical-subscriptions/${target.id}`, { method: 'DELETE' })
  } catch (cause) {
    // Already gone is what the person wanted.
    if (parseApiError(cause).kind !== 'not-found') {
      deleteError.value = describeError(cause, 'delete the subscription')
      deleting.value = false
      return
    }
  }
  subscriptions.update((current) => ({
    ...current,
    subscriptions: current.subscriptions.filter((item) => item.id !== target.id),
  }))
  checks.delete(target.id)
  sourcesChanged()
  notice.value = `Subscription “${target.name}” deleted.`
  deleteTarget.value = null
  deleting.value = false
}

// ---- Checking --------------------------------------------------------------------------------

const checks = reactive(new Map<number, CheckResult>())

async function checkSubscription(subscription: Subscription) {
  if (checks.get(subscription.id)?.state === 'checking') return
  checks.set(subscription.id, { state: 'checking', text: 'Checking the address…' })
  try {
    // Once is enough: ofetch would otherwise repeat a GET that failed with a 5xx.
    const document = await api<string>(`/api/ical-subscriptions/${subscription.id}/data`, {
      responseType: 'text',
      retry: 0,
    })
    checks.set(subscription.id, { state: 'ok', text: describeCheckSuccess(String(document)) })
  } catch (cause) {
    checks.set(subscription.id, {
      state: 'failed',
      text: `Check failed: ${describeCheckError(cause)}`,
    })
  }
}

function checkClass(id: number): string {
  const state = checks.get(id)?.state
  if (state === 'ok') return SUCCESS_TEXT
  if (state === 'failed') return ERROR_TEXT
  return 'text-toned'
}

function checkIcon(id: number): string {
  const state = checks.get(id)?.state
  if (state === 'ok') return 'i-lucide-circle-check'
  if (state === 'failed') return 'i-lucide-circle-alert'
  return 'i-lucide-loader-circle'
}
</script>
