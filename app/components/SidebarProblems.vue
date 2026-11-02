<!--
  What could not be loaded (NFR-4): one entry per failing calendar or source with a short reason and
  a Retry button. A problem with an external account's login also offers "Enter password
  again" (FR-8), which opens the password dialog and then loads everything again. Nothing is
  rendered while all is well. A problem is announced (role="alert") only when it appears; the
  same list read again later is plain text. The error colour is used for the border, tint and
  icon only; the text keeps the normal colour for contrast in both schemes. Rows wrap at narrow
  widths, so nothing is cut off at 360 px.
-->
<template>
  <section
    v-if="entries.length > 0"
    ref="section"
    :aria-labelledby="headingId"
    class="flex flex-col"
    data-sidebar-problems
  >
    <h2
      :id="headingId"
      class="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase"
    >
      {{ t('Problems') }}
    </h2>
    <ul class="flex flex-col gap-2">
      <li
        v-for="entry in entries"
        :key="entry.id"
        :role="fresh.has(entry.signature) && entry.retryKey ? 'alert' : undefined"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border p-2 text-sm text-default"
        :class="entry.retryKey ? 'border-error/50 bg-error/10' : 'border-warning/50 bg-warning/10'"
      >
        <UIcon
          :name="entry.retryKey ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'"
          class="size-4 shrink-0"
          :class="entry.retryKey ? 'text-error' : 'text-warning'"
          aria-hidden="true"
        />
        <p class="min-w-0 flex-1 basis-40 break-words">
          <span class="font-semibold">{{ entry.name }}</span>
          <span class="sr-only">: </span>
          <span class="block">{{ entry.message }}</span>
        </p>
        <UButton
          v-if="entry.passwordAccountId !== null"
          size="sm"
          color="neutral"
          variant="outline"
          class="min-h-11 shrink-0"
          icon="i-lucide-key-round"
          :aria-label="t('Enter password again for {name}', { name: entry.name })"
          @click="askPassword(entry.passwordAccountId)"
        >
          {{ t('Enter password again') }}
        </UButton>
        <UButton
          v-if="entry.retryKey"
          size="sm"
          color="neutral"
          variant="outline"
          class="min-h-11 shrink-0"
          :loading="retrying.has(entry.retryKey)"
          :aria-label="t('Retry {name}', { name: entry.name })"
          @click="retryEntry(entry.retryKey)"
        >
          {{ t('Retry') }}
        </UButton>
      </li>
    </ul>
  </section>

  <ExternalPasswordDialog
    :open="passwordTarget !== null"
    :account-name="shownAccountName"
    :username="shownUsername"
    :remember="shownRemember"
    :busy="savingPassword"
    :error="passwordError"
    :fallback="passwordFallback"
    @update:open="closePassword"
    @submit="savePassword"
  />
</template>

<script setup lang="ts">
import { useExternalAccess } from '~/composables/useExternalAccess'
import { useCalendarSourcesVersion, useLiveStatus } from '~/composables/useLiveCalendar'
import { enterPassword } from '~/utils/external/credentials'
import { rememberNote } from '~/utils/external/status'
import { t, tc } from '~/utils/i18n'
import { isSourceKey, sourceLabel } from '~/utils/live/errors'

interface Entry {
  id: string
  name: string
  message: string
  /** Set for failures, which can be retried; unset for notes. */
  retryKey: string | null
  /** The external account whose password a new one may cure; null for any other problem. */
  passwordAccountId: number | null
  /** What the announcement is keyed on: the same problem with the same words is not new. */
  signature: string
}

const { errors, skipped, retry, passwordFor, externalAccounts } = useLiveStatus()
const { calendarById } = useCalendarState()
const external = useExternalAccess()
const toast = useToast()
const sourcesVersion = useCalendarSourcesVersion()

const headingId = useId()
const section = ref<HTMLElement | null>(null)

const nameOf = (key: string) =>
  isSourceKey(key)
    ? sourceLabel(key, (id) => externalAccounts.value.find((account) => account.id === id)?.name)
    : (calendarById.value.get(key)?.name ?? t('Calendar'))

const entries = computed<Entry[]>(() => {
  const failures = Object.entries(errors.value).map(([key, message]) => ({
    id: `error:${key}`,
    name: nameOf(key),
    message,
    retryKey: key,
    passwordAccountId: passwordFor.value[key] ?? null,
    signature: `error:${key}:${message}`,
  }))
  // A calendar that failed as a whole needs no second note about its entries.
  const notes = Object.entries(skipped.value)
    .filter(([key]) => !(key in errors.value))
    .map(([key, count]) => ({
      id: `note:${key}`,
      name: nameOf(key),
      message: tc(
        '{count} entry could not be read and is not shown | {count} entries could not be read and are not shown',
        count,
      ),
      retryKey: null,
      passwordAccountId: null,
      signature: `note:${key}:${count}`,
    }))
  return [...failures, ...notes]
})

// Signatures shown before, kept for the session: a problem that is on screen already (the slideover
// was closed and opened again) is not announced a second time.
const announced = useState<string[]>('live-problems-announced', () => [])
const fresh = computed(
  () => new Set(entries.value.map((e) => e.signature).filter((s) => !announced.value.includes(s))),
)
// After the render that carried role="alert", the entries count as announced.
function markAnnounced() {
  announced.value = entries.value.map((entry) => entry.signature)
}
watch(entries, markAnnounced, { flush: 'post' })
onMounted(markAnnounced)

const retrying = reactive(new Set<string>())

// ---- Enter password again ----

const passwordTarget = ref<number | null>(null)
// Keep the words while the dialog fades out.
const shownAccountName = ref('')
const shownUsername = ref<string | null>(null)
const shownRemember = ref(false)
const savingPassword = ref(false)
const passwordError = ref<string | null>(null)
// The problem (and the button that opened the dialog) is gone once the login works: focus then
// goes to the sidebar itself, not to the page.
const passwordFallback = ref<HTMLElement | null>(null)

function askPassword(accountId: number) {
  const account = externalAccounts.value.find((candidate) => candidate.id === accountId)
  if (!account) return
  shownAccountName.value = account.name
  shownUsername.value = account.username
  shownRemember.value = external.seals.isRemembered(accountId)
  passwordError.value = null
  passwordFallback.value = section.value?.closest<HTMLElement>('aside, [role="dialog"]') ?? null
  passwordFallback.value?.setAttribute('tabindex', '-1')
  passwordTarget.value = accountId
}

function closePassword(open: boolean) {
  if (!open && !savingPassword.value) passwordTarget.value = null
}

async function savePassword(input: { password: string; remember: boolean }) {
  const accountId = passwordTarget.value
  if (accountId === null || savingPassword.value) return
  savingPassword.value = true
  passwordError.value = null
  const outcome = await enterPassword(external, accountId, input.password, input.remember)
  savingPassword.value = false
  if (!outcome.ok) {
    passwordError.value = outcome.message
    return
  }
  passwordTarget.value = null
  if (input.remember && !outcome.remembered) {
    toast.add({
      title: t('Password saved'),
      description: rememberNote(true, false).trim(),
      icon: 'i-lucide-info',
    })
  }
  // The login is the same for all of the account's calendars: load everything again.
  sourcesVersion.value++
}

async function retryEntry(key: string) {
  if (retrying.has(key)) return
  retrying.add(key)
  const container = section.value?.closest<HTMLElement>('aside, [role="dialog"]') ?? null
  try {
    await retry(key)
  } finally {
    retrying.delete(key)
  }
  // The entry (and the button that had focus) is gone when the retry worked: keep keyboard users
  // in the sidebar instead of dropping them on the page.
  await nextTick()
  if (!document.activeElement || document.activeElement === document.body) {
    const target = section.value ?? container?.querySelector<HTMLElement>('button, [href], input')
    if (target && target === section.value) target.setAttribute('tabindex', '-1')
    target?.focus()
  }
}
</script>
