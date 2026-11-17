<!--
  iCal subscriptions (FR-7, the address half; the file half is ImportSection.vue): read-only
  calendars from an .ics address. "Add subscription", beside the heading, and "Edit" on a row open
  the same dialog with SubscriptionForm; it closes when the server has taken the change and stays
  open with the reason when not. What happened is told in a toast and a failed request also in the
  dialog, so the list never moves. The server fetches the file (browsers cannot read arbitrary
  addresses), so "Check" asks it to try and reports the outcome in the row, on a line that is there
  from the start. Shared subscriptions (offered to everybody) are listed read-only. Every change
  bumps `calendar-sources-version`, which the calendar view watches to load its sources again.
-->
<template>
  <section aria-labelledby="settings-subscriptions" class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 id="settings-subscriptions" ref="heading" tabindex="-1" class="text-lg font-semibold">
        {{ t('iCal subscriptions') }}
      </h2>
      <UButton
        :label="t('Add subscription')"
        icon="i-lucide-plus"
        aria-haspopup="dialog"
        @click="askAdd"
      />
    </div>
    <p>
      <template
        v-for="(part, i) in tparts(
          'Show a calendar from a web address (an {ics} file) next to your own calendars. It is read-only: changes have to be made at its source. If you have a file instead of an address, you can import its events into one of your calendars.',
        )"
        :key="i"
      >
        <code v-if="'name' in part">.ics</code>
        <template v-else>{{ part.text }}</template>
      </template>
    </p>

    <SettingsErrorAlert
      v-if="subscriptions.error.value"
      :message="subscriptions.error.value"
      retryable
      @retry="subscriptions.reload()"
    />

    <template v-if="list">
      <ul
        v-if="list.subscriptions.length > 0"
        :aria-label="t('Your calendar subscriptions')"
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
                  :label="t('Shared')"
                  icon="i-lucide-users"
                  color="neutral"
                  variant="outline"
                />
              </p>
              <p class="truncate text-sm text-toned" :title="subscription.url">
                <span class="sr-only">{{ t('Address: ') }}</span
                >{{ subscription.url }}
              </p>
              <p class="sr-only">
                {{ t('Colour: {colour}', { colour: colorName(subscription.color) }) }}
              </p>
              <p v-if="subscription.shared" class="text-sm text-toned">
                {{ t('Shared with everyone. Only an administrator can change it.') }}
              </p>
            </div>
          </div>

          <p
            role="status"
            aria-live="polite"
            class="flex min-h-5 items-start gap-1.5 text-sm"
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
              :label="
                checks.get(subscription.id)?.state === 'checking' ? t('Checking…') : t('Check')
              "
              icon="i-lucide-activity"
              color="neutral"
              variant="outline"
              :aria-label="t('Check {name}', { name: subscription.name })"
              :aria-busy="checks.get(subscription.id)?.state === 'checking'"
              @click="checkSubscription(subscription)"
            />
            <template v-if="!subscription.shared">
              <UButton
                :label="t('Edit')"
                icon="i-lucide-pencil"
                color="neutral"
                variant="outline"
                :aria-label="t('Edit {name}', { name: subscription.name })"
                @click="askEdit(subscription)"
              />
              <UButton
                :label="t('Delete')"
                icon="i-lucide-trash-2"
                color="neutral"
                variant="outline"
                :class="ERROR_TEXT"
                :aria-label="t('Delete {name}', { name: subscription.name })"
                @click="askDelete(subscription)"
              />
            </template>
          </div>
        </li>
      </ul>
      <p v-else>{{ t('You have no calendar subscriptions yet.') }}</p>
    </template>
    <div v-else-if="!subscriptions.error.value" class="flex flex-col gap-2" role="status">
      <span class="sr-only">{{ t('Loading calendar subscriptions') }}</span>
      <USkeleton v-for="row in 2" :key="row" class="h-28 w-full" aria-hidden="true" />
    </div>

    <!-- Adding (no subscription) and changing one. -->
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
          <SettingsSubscriptionForm
            v-if="formOpen"
            :key="formKey"
            ref="form"
            :submit-label="editTarget ? t('Save changes') : t('Add subscription')"
            cancelable
            :subscription="editTarget ?? undefined"
            :busy="saving"
            :server-errors="formErrors"
            @submit="saveSubscription"
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
          'The calendar is removed from your subscriptions. The calendar at its source is not affected.',
        )
      "
      :confirm-label="t('Delete subscription')"
      :busy="deleting"
      :error="deleteError"
      :fallback="heading"
      @update:open="closeDelete"
      @confirm="deleteSubscription"
    />
  </section>
</template>

<script setup lang="ts">
import { N_, t, tparts } from '~/utils/i18n'
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
}

const api = useAuthFetch()
const notify = useNotify()
// The calendar view reloads its sources when this changes (the live data loader watches it).
const sourcesVersion = useState<number>('calendar-sources-version', () => 0)

const subscriptions = createResource(
  () => api<SubscriptionList>('/api/ical-subscriptions'),
  N_('load your calendar subscriptions'),
)
const list = subscriptions.data
onMounted(() => subscriptions.reload())

const heading = useTemplateRef<HTMLElement>('heading')
const form = useTemplateRef<FormHandle>('form')

function sourcesChanged() {
  sourcesVersion.value++
}

/** '' (the form's "default colour") is stored as no colour. */
function toBody(input: SubscriptionInput) {
  return { name: input.name, url: input.url, color: input.color || null }
}

// ---- Adding and changing ---------------------------------------------------------------------

const formOpen = ref(false)
/** The subscription being changed; null while adding. */
const editTarget = ref<Subscription | null>(null)
/** Each opening gets a fresh form. */
const formKey = ref(0)
const saving = ref(false)
const formErrors = ref<Record<string, string>>()
const formAlert = ref<string | null>(null)
const formFocus = createFocusReturn(() => heading.value)
// Kept while the dialog fades out.
const shownForm = ref({ title: '', description: '' })

function openForm(subscription: Subscription | null) {
  formFocus.remember()
  formErrors.value = undefined
  formAlert.value = null
  editTarget.value = subscription
  formKey.value++
  shownForm.value = subscription
    ? {
        title: t('Edit subscription'),
        description: t('Change the name, address or colour of {name}', { name: subscription.name }),
      }
    : {
        title: t('Add subscription'),
        description: t('Enter the address of a calendar file and a name for it.'),
      }
  formOpen.value = true
}

function askAdd() {
  openForm(null)
}

function askEdit(subscription: Subscription) {
  openForm(subscription)
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

async function saveSubscription(input: SubscriptionInput) {
  if (saving.value) return
  const target = editTarget.value
  saving.value = true
  formErrors.value = undefined
  formAlert.value = null
  try {
    if (target) {
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
      notify.done(t('Subscription “{name}” saved.', { name: saved.name }))
    } else {
      const created = await api<Subscription>('/api/ical-subscriptions', {
        method: 'POST',
        body: toBody(input),
      })
      subscriptions.update((current) => ({
        ...current,
        subscriptions: [...current.subscriptions, created],
      }))
      notify.done(t('Subscription “{name}” added.', { name: created.name }))
    }
    sourcesChanged()
    formOpen.value = false
    editTarget.value = null
  } catch (cause) {
    const failure = describeSubscriptionSaveError(
      cause,
      target ? N_('save the subscription') : N_('add the subscription'),
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
      deleteError.value = describeError(cause, N_('delete the subscription'))
      notify.failed(deleteError.value)
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
  notify.done(t('Subscription “{name}” deleted.', { name: target.name }))
  deleteTarget.value = null
  deleting.value = false
}

// ---- Checking --------------------------------------------------------------------------------

const checks = reactive(new Map<number, CheckResult>())

async function checkSubscription(subscription: Subscription) {
  if (checks.get(subscription.id)?.state === 'checking') return
  checks.set(subscription.id, { state: 'checking', text: t('Checking the address…') })
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
      text: t('Check failed: {reason}', { reason: describeCheckError(cause) }),
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
