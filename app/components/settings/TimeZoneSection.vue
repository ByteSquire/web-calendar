<!--
  Time zone (FR-32): the zone the calendar shows times in, the browser's unless the user chose
  another. A choice is saved at once (`PUT /api/me/time-zone`) and belongs to the account, so it
  follows the user to other browsers. The screens read it from `useUserTimeZone()`, which is why
  they switch without a reload. In demo mode there is no account to save it in: the choice lasts
  until the page is reloaded. The data comes from the page (`/api/me` is loaded once, as for the
  account section).
-->
<template>
  <section aria-labelledby="settings-time-zone" class="flex flex-col gap-4">
    <h2 id="settings-time-zone" tabindex="-1" class="text-lg font-semibold">Time zone</h2>
    <p>
      Times in the calendar are shown in the zone you choose here, by default your browser's zone.
      All-day events stay on their dates.
    </p>

    <SettingsErrorAlert v-if="alert" :message="alert" />

    <div v-if="ready" class="flex flex-col gap-2" :aria-busy="saving">
      <UFormField label="Show times in">
        <USelectMenu
          :model-value="selected"
          :items="items"
          value-key="value"
          :filter-fields="['search']"
          :search-input="SEARCH_INPUT"
          :loading="saving"
          class="w-full max-w-md"
          :ui="SELECT_UI"
          @update:model-value="choose"
        >
          <template #empty>No time zone matches your search.</template>
        </USelectMenu>
      </UFormField>
      <p class="text-sm text-toned">
        Organization time zone: <strong>{{ orgZone }}</strong
        >. Events without a zone use it.
      </p>
    </div>
    <p v-else-if="error" class="text-toned">
      Your time zone setting is not available because your account could not be loaded.
    </p>
    <!-- The room of the control, so nothing moves when the data arrives. -->
    <div v-else class="flex flex-col gap-2" role="status">
      <span class="sr-only">Loading your time zone</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>
  </section>
</template>

<script setup lang="ts">
import { resolveDisplayTimeZone } from '../../../shared/utils/time-zone'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { describeError } from '~/utils/settings/api-errors'
import { BROWSER_CHOICE, describeZoneChange, timeZoneChoices } from '~/utils/settings/time-zone'
import type { MeResponse } from '~/utils/settings/types'

const props = defineProps<{
  me: MeResponse | null
  /** Why `/api/me` failed, worded for people. */
  error: string | null
}>()

// Nuxt UI sizes controls at about 32 px; the same 44 px as in the event form (EventFormFields.vue).
const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }
// The search field of the list is named; a placeholder is no name for assistive technology.
const SEARCH_INPUT = { placeholder: 'Search time zones', 'aria-label': 'Search time zones' }

const api = useAuthFetch()
const config = useServerConfigState()
const isDemo = computed(() => config.value?.demo === true)
const userZone = useUserTimeZone()
const displayZone = useDisplayTimeZone()
const orgZone = useOrgTimeZone()
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
// The zone times are shown in without a choice: the browser's, else the organization's.
const defaultZone = computed(() => resolveDisplayTimeZone(browserZone, orgZone.value))

const ready = computed(() => isDemo.value || props.me !== null)
const selected = computed(() => userZone.value ?? BROWSER_CHOICE)
const items = computed(() =>
  timeZoneChoices({
    defaultZone: defaultZone.value,
    orgZone: orgZone.value,
    current: userZone.value,
  }),
)

// The saved choice comes with the account; the calendar reads it from the shared state. Demo mode
// has no account, so what was chosen on this page stays.
watch(
  () => props.me,
  (me) => {
    if (me && !isDemo.value) userZone.value = me.timeZone
  },
  { immediate: true },
)

const saving = ref(false)
const alert = ref<string | null>(null)
const notice = ref('')

async function choose(value: unknown) {
  if (typeof value !== 'string' || saving.value) return
  const zone = value === BROWSER_CHOICE ? null : value
  if (zone === userZone.value) return
  saving.value = true
  alert.value = null
  notice.value = ''
  try {
    const saved = isDemo.value
      ? { timeZone: zone }
      : await api<{ timeZone: string | null }>('/api/me/time-zone', {
          method: 'PUT',
          body: { timeZone: zone },
        })
    userZone.value = saved.timeZone
    notice.value = describeZoneChange(saved.timeZone, displayZone.value)
  } catch (cause) {
    alert.value = describeError(cause, 'save your time zone')
  } finally {
    saving.value = false
  }
}
</script>
