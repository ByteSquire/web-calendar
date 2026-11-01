<!--
  Access administration (FR-14), admins only: pick a calendar, see who may do what with it and
  whether the calendar server has the rule yet, add and remove rules. The page checks `/api/me`
  and sends everybody else back to the calendar; that is only tidiness, the admin routes refuse
  non-admins themselves. Every add or remove sends the complete rule list of the calendar.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        Back to calendar
      </NuxtLink>
      <h1 class="text-2xl font-semibold">Calendar access</h1>
    </header>

    <div v-if="checking" role="status" class="flex flex-col gap-2">
      <span class="sr-only">Checking your permissions</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <SettingsErrorAlert
      v-else-if="admin === null"
      message="Could not check whether you may manage access. Try again."
      retryable
      @retry="start()"
    />

    <template v-else-if="admin">
      <p>
        Choose who may see or change each calendar. The calendar server enforces these rules for
        every app, not only this one.
      </p>

      <SettingsErrorAlert
        v-if="access.calendars.error.value"
        :message="access.calendars.error.value"
        retryable
        @retry="start()"
      />
      <SettingsErrorAlert v-if="access.users.error.value" :message="access.users.error.value" />

      <p v-if="loaded && calendarItems.length === 0" data-access-none class="text-toned">
        There are no calendars to manage yet.
      </p>

      <template v-if="current">
        <UFormField label="Calendar">
          <USelectMenu
            v-model="selectedId"
            :items="calendarItems"
            value-key="value"
            :search-input="SEARCH_CALENDARS"
            class="w-full max-w-md"
            :ui="{ base: 'min-h-11', item: 'min-h-11 items-center' }"
          />
        </UFormField>

        <section aria-labelledby="access-rules-heading" class="flex flex-col gap-3">
          <h2 id="access-rules-heading" class="text-lg font-semibold">
            Who has access to {{ current.name }}
          </h2>
          <p v-if="current.owner" class="text-toned">
            Owner: {{ current.owner }} (always has full access).
          </p>
          <SettingsErrorAlert v-if="problem" :message="problem" />
          <AdminAccessRuleList
            :rules="current.rules"
            :calendar-name="current.name"
            :busy="saving"
            @remove="remove"
          />
          <p v-if="pendingCount > 0" class="text-sm text-toned">
            {{ pendingCount }} {{ pendingCount === 1 ? 'rule is' : 'rules are' }} pending. They are
            sent to the calendar server shortly; reload to see when they are applied.
          </p>
          <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>
        </section>

        <AdminAccessAddForm
          :users="access.users.data.value ?? []"
          :groups-available="groupsAvailable"
          :busy="saving"
          :save="add"
        />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useAdminAccess, useAdminFlag } from '~/composables/useAdminAccess'
import type { AccessRule, AccessRuleInput } from '~/utils/admin/access'
import { levelLabel, withRule, withoutRule } from '~/utils/admin/access'

useHead({ title: 'Calendar access' })

const SEARCH_CALENDARS = { placeholder: 'Search calendars', 'aria-label': 'Search calendars' }

const router = useRouter()
const { admin, ensure } = useAdminFlag()
const access = useAdminAccess()
const checking = ref(true)
const loaded = ref(false)
const selectedId = ref<number | undefined>(undefined)
const saving = ref(false)
const problem = ref<string | null>(null)
const notice = ref('')

const calendarItems = computed(() =>
  (access.calendars.data.value?.calendars ?? []).map((calendar) => ({
    value: calendar.id,
    label: calendar.name,
  })),
)
const current = computed(
  () => access.calendars.data.value?.calendars.find((item) => item.id === selectedId.value) ?? null,
)
const groupsAvailable = computed(() => access.calendars.data.value?.groupsAvailable === true)
const pendingCount = computed(
  () => current.value?.rules.filter((rule) => !rule.applied).length ?? 0,
)

async function start() {
  checking.value = true
  const isAdmin = await ensure()
  checking.value = false
  if (isAdmin === false) {
    await router.replace('/')
    return
  }
  if (isAdmin !== true) return
  await Promise.all([access.calendars.reload(), access.users.reload()])
  loaded.value = access.calendars.data.value !== null
  const first = access.calendars.data.value?.calendars[0]
  if (selectedId.value === undefined && first) selectedId.value = first.id
}

onMounted(start)

watch(selectedId, () => {
  problem.value = null
  notice.value = ''
})

function labelOf(rule: AccessRuleInput): string {
  if (rule.principalType === 'authenticated') return 'Everyone signed in'
  if (rule.principalType === 'group') return `Group ${rule.principal}`
  const known = current.value?.rules.find((item) => item.principal === rule.principal)
  return known?.label ?? 'This person'
}

async function change(rules: AccessRuleInput[], done: string): Promise<boolean> {
  const calendar = current.value
  if (!calendar || saving.value) return false
  saving.value = true
  problem.value = null
  notice.value = ''
  const result = await access.saveRules(calendar.id, rules, labelOf)
  saving.value = false
  if (result.ok) notice.value = done
  else problem.value = result.message
  return result.ok
}

function add(rule: AccessRuleInput, label: string): Promise<boolean> {
  const calendar = current.value
  if (!calendar) return Promise.resolve(false)
  return change(
    withRule(calendar.rules, rule),
    `Access for ${label} is now: ${levelLabel(rule.permission)}.`,
  )
}

function remove(rule: AccessRule) {
  const calendar = current.value
  if (!calendar) return
  void change(withoutRule(calendar.rules, rule.id), `${rule.label} no longer has access.`)
}
</script>
