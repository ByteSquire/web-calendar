<!--
  Admin › People, admins only and read only: everybody who has signed in once, with a search, and
  for one person what the app holds about them: their groups (and the ones they manage), their own
  calendars, the calendars shared with them and the links they made. It answers "who sees what";
  access is changed on Admin › Calendars and Groups. The admin badge says what the identity
  provider said at the person's last sign-in; it may be out of date, and nothing decides on it. No
  e-mail address and no secret of a link is shown. The page checks `/api/me` and sends everybody
  else back to the calendar; the admin routes refuse non-admins themselves.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to calendar') }}
      </NuxtLink>
      <h1 class="text-2xl font-semibold">{{ t('People') }}</h1>
    </header>

    <div v-if="checking" role="status" class="flex flex-col gap-2">
      <span class="sr-only">{{ t('Checking your permissions') }}</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <SettingsErrorAlert
      v-else-if="admin === null"
      :message="t('Could not check whether you may see the people. Try again.')"
      retryable
      @retry="start()"
    />

    <template v-else-if="admin">
      <p>
        {{
          t(
            'Everybody who has signed in once: their groups, their calendars, the calendars shared with them and the links they made. Change access on the Calendars and Groups pages.',
          )
        }}
      </p>

      <SettingsErrorAlert v-if="loadError" :message="loadError" retryable @retry="start()" />
      <p v-if="truncated" class="text-sm text-toned">
        {{
          t('Only the first {count} people are listed, sorted by name.', {
            count: people.length,
          })
        }}
      </p>

      <UFormField :label="t('Search people')" class="max-w-md">
        <UInput v-model="query" type="search" autocomplete="off" class="w-full" />
      </UFormField>

      <p v-if="loaded && shown.length === 0" data-people-none class="text-toned">
        {{ people.length === 0 ? t('Nobody has signed in yet.') : t('Nobody matches.') }}
      </p>

      <ul v-if="shown.length > 0" :aria-label="t('People')" class="flex flex-col gap-2">
        <li
          v-for="person in shown"
          :key="person.id"
          data-admin-person
          class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
        >
          <UIcon name="i-lucide-user" class="size-5 shrink-0" aria-hidden="true" />
          <div class="min-w-0 flex-1 basis-48">
            <p class="font-medium wrap-anywhere">{{ userLabel(person) }}</p>
            <p class="text-sm text-toned wrap-anywhere">{{ lastSeen(person) }}</p>
          </div>
          <UBadge
            v-if="person.adminAtLastSignIn"
            :label="t('Admin')"
            icon="i-lucide-shield-check"
            color="neutral"
            variant="outline"
          />
          <UButton
            :aria-label="t('Open {name}', { name: userLabel(person) })"
            icon="i-lucide-eye"
            :label="t('Open')"
            color="neutral"
            variant="outline"
            @click="open(person)"
          />
        </li>
      </ul>

      <UModal
        :open="openId !== null"
        :title="openPerson ? userLabel(openPerson) : ''"
        :description="openPerson ? lastSeen(openPerson) : ''"
        :ui="{ content: 'sm:max-w-2xl', title: 'wrap-anywhere' }"
        @update:open="(next) => (next ? undefined : (openId = null))"
      >
        <template #body>
          <div class="flex flex-col gap-6">
            <div v-if="detailPending" role="status" class="flex flex-col gap-2">
              <span class="sr-only">{{ t('Loading') }}</span>
              <USkeleton class="h-11 w-full" aria-hidden="true" />
            </div>
            <SettingsErrorAlert v-if="detailError" :message="detailError" />

            <template v-if="detail">
              <p v-if="detail.adminAtLastSignIn" class="text-sm text-toned">
                {{
                  t(
                    'An administrator at their last sign-in. Whether they still are is asked of the identity provider each time.',
                  )
                }}
              </p>
              <section aria-labelledby="person-groups" class="flex flex-col gap-2">
                <h3 id="person-groups" class="font-semibold">{{ t('Groups') }}</h3>
                <p v-if="detail.groups.length === 0" class="text-toned">
                  {{ t('In no group.') }}
                </p>
                <ul v-else class="flex flex-col gap-1">
                  <li
                    v-for="group in detail.groups"
                    :key="group.id"
                    class="flex flex-wrap items-center gap-2"
                  >
                    <span class="wrap-anywhere">{{ group.name }}</span>
                    <span class="text-sm text-toned">{{ sourceLabel(group.source) }}</span>
                    <UBadge
                      v-if="group.manager"
                      :label="t('Manager')"
                      icon="i-lucide-user-cog"
                      color="neutral"
                      variant="subtle"
                    />
                  </li>
                </ul>
              </section>

              <section aria-labelledby="person-calendars" class="flex flex-col gap-2">
                <h3 id="person-calendars" class="font-semibold">{{ t('Own calendars') }}</h3>
                <p v-if="detail.calendars.length === 0" class="text-toned">
                  {{ t('No calendar of their own yet.') }}
                </p>
                <ul v-else class="flex flex-col gap-1">
                  <li v-for="calendar in detail.calendars" :key="calendar.id">
                    <NuxtLink :to="calendarsPage(calendar.name)" class="underline wrap-anywhere">
                      {{ calendar.name }}
                    </NuxtLink>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="person-shared" class="flex flex-col gap-2">
                <h3 id="person-shared" class="font-semibold">
                  {{ t('Calendars shared with them') }}
                </h3>
                <p v-if="detail.shared.length === 0" class="text-toned">
                  {{ t('No calendar is shared with them.') }}
                </p>
                <ul v-else class="flex flex-col gap-1">
                  <li v-for="calendar in detail.shared" :key="calendar.id">
                    <NuxtLink :to="calendarsPage(calendar.name)" class="underline wrap-anywhere">
                      {{ calendarLabel(calendar) }}
                    </NuxtLink>
                  </li>
                </ul>
              </section>

              <section aria-labelledby="person-links" class="flex flex-col gap-2">
                <h3 id="person-links" class="font-semibold">{{ t('Links they made') }}</h3>
                <p v-if="detail.links.length === 0" class="text-toned">
                  {{ t('No links.') }}
                </p>
                <ul v-else class="flex flex-col gap-1">
                  <li v-for="link in detail.links" :key="link.id" class="wrap-anywhere">
                    {{
                      t('{label}: {calendar}, {level}', {
                        label: link.label,
                        calendar: link.calendarName,
                        level: levelLabel(link.level),
                      })
                    }}
                  </li>
                </ul>
              </section>
            </template>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end">
            <UButton :label="t('Close')" color="neutral" variant="outline" @click="openId = null" />
          </div>
        </template>
      </UModal>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useAdminFlag } from '~/composables/useAdminAccess'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { calendarLabel, levelLabel, userLabel } from '~/utils/admin/access'
import type { AdminPerson, AdminPersonDetail } from '~/utils/admin/people'
import { sourceLabel } from '~/utils/groups/model'
import { N_, t } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'
import { formatDateTime } from '~/utils/settings/format'

useHead({ title: () => t('People') })

const router = useRouter()
const { admin, ensure } = useAdminFlag()
const api = useAuthFetch()
const displayZone = useDisplayTimeZone()

const checking = ref(true)
const loaded = ref(false)
const loadError = ref<string | null>(null)
const people = ref<AdminPerson[]>([])
const truncated = ref(false)
const query = ref('')
const openId = ref<number | null>(null)
const detail = ref<AdminPersonDetail | null>(null)
const detailPending = ref(false)
const detailError = ref<string | null>(null)

const shown = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (needle === '') return people.value
  return people.value.filter((person) =>
    [person.name, person.username].some((text) => text?.toLowerCase().includes(needle)),
  )
})
const openPerson = computed(() => people.value.find((person) => person.id === openId.value))

function lastSeen(person: AdminPerson): string {
  return person.lastSeenAt
    ? t('Last signed in {date}', { date: formatDateTime(person.lastSeenAt, displayZone.value) })
    : t('No sign-in recorded')
}

/** Admin › Calendars, searching for the calendar (the page lists them by name). */
const calendarsPage = (name: string) => ({ path: '/admin/calendars', query: { q: name } })

async function start() {
  checking.value = true
  const isAdmin = await ensure()
  checking.value = false
  if (isAdmin === false) {
    await router.replace('/')
    return
  }
  if (isAdmin !== true) return
  try {
    const answer = await api<{ people: AdminPerson[]; truncated: boolean }>('/api/admin/people')
    people.value = answer.people
    truncated.value = answer.truncated
    loadError.value = null
    loaded.value = true
  } catch (cause) {
    loadError.value = describeError(cause, N_('load the people'))
  }
}

onMounted(start)

async function open(person: AdminPerson) {
  openId.value = person.id
  detail.value = null
  detailError.value = null
  detailPending.value = true
  try {
    const answer = await api<AdminPersonDetail>(`/api/admin/people/${person.id}`)
    if (openId.value === person.id) detail.value = answer
  } catch (cause) {
    if (openId.value === person.id) detailError.value = describeError(cause, N_('load the person'))
  } finally {
    if (openId.value === person.id) detailPending.value = false
  }
}
</script>
