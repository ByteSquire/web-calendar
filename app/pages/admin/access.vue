<!--
  Access administration (FR-14), admins only: pick a calendar, see who may do what with it and
  whether the calendar server has the rule yet, add and remove rules. Above the rules: the links to
  the calendar (FR-26a), the ones made here and the ones people made in Settings, with their address
  and password; a link made here reads the calendar as its owner. The page checks `/api/me`
  and sends everybody else back to the calendar; that is only tidiness, the admin routes refuse
  non-admins themselves. Every add or remove sends the complete rule list of the calendar.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to calendar') }}
      </NuxtLink>
      <h1 class="text-2xl font-semibold">{{ t('Calendar access') }}</h1>
    </header>

    <div v-if="checking" role="status" class="flex flex-col gap-2">
      <span class="sr-only">{{ t('Checking your permissions') }}</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <SettingsErrorAlert
      v-else-if="admin === null"
      :message="t('Could not check whether you may manage access. Try again.')"
      retryable
      @retry="start()"
    />

    <template v-else-if="admin">
      <p>
        {{
          t(
            'Choose who may see or change each calendar. The calendar server enforces these rules for every app, not only this one.',
          )
        }}
      </p>

      <SettingsErrorAlert
        v-if="access.calendars.error.value"
        :message="access.calendars.error.value"
        retryable
        @retry="start()"
      />
      <SettingsErrorAlert v-if="access.users.error.value" :message="access.users.error.value" />
      <SettingsErrorAlert v-if="access.groups.error.value" :message="access.groups.error.value" />

      <p v-if="loaded && calendarItems.length === 0" data-access-none class="text-toned">
        {{ t('There are no calendars to manage yet.') }}
      </p>

      <template v-if="current">
        <UFormField :label="t('Calendar')">
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
            {{ t('Who has access to {name}', { name: current.name }) }}
          </h2>
          <LinksCalendarLinks
            :key="current.id"
            :title="t('Links')"
            :calendar-id="current.id"
            :calendar-name="current.name"
          >
            <p class="text-sm text-toned">
              {{
                t(
                  'A link gives people without an account a view of this calendar, behind a password, at the access level you choose.',
                )
              }}
            </p>
          </LinksCalendarLinks>
          <h3 class="font-semibold">{{ t('People and groups') }}</h3>
          <p v-if="current.owner" class="text-toned">
            {{ t('Owner: {name} (always has full access).', { name: current.owner }) }}
          </p>
          <SettingsErrorAlert v-if="problem" :message="problem" />
          <AdminAccessRuleList
            :rules="current.rules"
            :calendar-name="current.name"
            :busy="saving"
            @remove="remove"
          />
          <p v-if="pendingCount > 0" class="text-sm text-toned">
            {{
              tc(
                '{count} rule is pending. They are sent to the calendar server shortly; reload to see when they are applied. | {count} rules are pending. They are sent to the calendar server shortly; reload to see when they are applied.',
                pendingCount,
              )
            }}
          </p>
          <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>
        </section>

        <AdminAccessAddForm
          :users="access.users.data.value ?? []"
          :groups="access.groups.data.value ?? []"
          :busy="saving"
          :levels="ACCESS_LEVELS"
          default-level="read"
          :save="add"
        />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { principalLabel } from '~/utils/principal-label'
import { useAdminAccess, useAdminFlag } from '~/composables/useAdminAccess'
import type { AccessRule, AccessRuleInput } from '~/utils/admin/access'
import {
  ACCESS_LEVELS,
  calendarLabel,
  levelLabel,
  withRule,
  withoutRule,
} from '~/utils/admin/access'
import { t, tc } from '~/utils/i18n'

useHead({ title: () => t('Calendar access') })

const SEARCH_CALENDARS = computed(() => ({
  placeholder: t('Search calendars'),
  'aria-label': t('Search calendars'),
}))

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
    label: calendarLabel(calendar),
  })),
)
const current = computed(
  () => access.calendars.data.value?.calendars.find((item) => item.id === selectedId.value) ?? null,
)
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
  await Promise.all([access.calendars.reload(), access.users.reload(), access.groups.reload()])
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
  if (rule.principalType === 'authenticated') return t('Everyone signed in')
  if (rule.principalType === 'group') return t('Group {name}', { name: rule.principal ?? '' })
  const known = current.value?.rules.find((item) => item.principal === rule.principal)
  return known ? principalLabel(known.principalType, known.label) : t('This person')
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
    t('Access for {label} is now: {level}.', { label, level: levelLabel(rule.permission) }),
  )
}

function remove(rule: AccessRule) {
  const calendar = current.value
  if (!calendar) return
  void change(
    withoutRule(calendar.rules, rule.id),
    t('{label} no longer has access.', { label: principalLabel(rule.principalType, rule.label) }),
  )
}
</script>
