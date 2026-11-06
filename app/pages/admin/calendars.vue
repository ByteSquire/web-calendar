<!--
  Admin › Calendars (FR-14), admins only: every calendar of the app, people's, the organization's,
  the groups' and the resources', with a filter by whom they belong to and a search. A calendar
  opens in one dialog with two tabs, as a resource does: "Details" renames it, changes its own colour
  (everybody sees it who has not picked their own) and deletes it; "Who has access" shows the links
  to it (FR-26a) and its access rules, whether the calendar server has each rule yet, and adds and
  removes them (every change sends the complete rule list). "New calendar" makes a calendar of the
  organization, which belongs to nobody, so nobody sees it until a rule shares it: the dialog then
  opens on "Who has access". A resource's calendar is deleted with its resource, on Admin ›
  Resources, and a person's default calendar is not deleted at all (they always keep one).
  `?open=<id>` or `?path=<collection path>` (from "Edit calendar" in the sidebar) opens a calendar. The page checks `/api/me` and sends everybody else back to the calendar; that is only
  tidiness, the admin routes refuse non-admins themselves. The old address /admin/access opens it.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to calendar') }}
      </NuxtLink>
      <h1 class="text-2xl font-semibold">{{ t('Calendars') }}</h1>
    </header>

    <div v-if="checking" role="status" class="flex flex-col gap-2">
      <span class="sr-only">{{ t('Checking your permissions') }}</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <SettingsErrorAlert
      v-else-if="admin === null"
      :message="t('Could not check whether you may manage calendars. Try again.')"
      retryable
      @retry="start()"
    />

    <template v-else-if="admin">
      <p>
        {{
          t(
            'Every calendar of the app. Rename it, change its colour or delete it, and choose who may see or change it. The calendar server enforces these rules for every app, not only this one.',
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
      <p v-if="openId === null" role="status" aria-live="polite" class="min-h-5 text-sm">
        {{ notice }}
      </p>

      <div class="flex flex-wrap items-end gap-3">
        <UFormField :label="t('Search calendars')" class="min-w-0 flex-1 basis-56">
          <UInput v-model="query" type="search" autocomplete="off" class="w-full" />
        </UFormField>
        <UButton
          :label="t('New calendar')"
          icon="i-lucide-plus"
          :disabled="!loaded"
          @click="createOpen = true"
        />
      </div>

      <URadioGroup
        v-model="kind"
        :legend="t('Show')"
        :items="kindItems"
        orientation="horizontal"
        :ui="{ fieldset: 'flex-wrap gap-x-4 gap-y-1', item: 'min-h-11 items-center' }"
      />

      <p v-if="loaded && calendars.length === 0" data-access-none class="text-toned">
        {{ t('There are no calendars to manage yet.') }}
      </p>
      <p v-else-if="loaded && shown.length === 0" data-calendars-none class="text-toned">
        {{ t('No calendar matches.') }}
      </p>

      <ul v-if="shown.length > 0" :aria-label="t('Calendars')" class="flex flex-col gap-2">
        <li
          v-for="calendar in shown"
          :key="calendar.id"
          data-admin-calendar
          class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
        >
          <span
            class="size-5 shrink-0 rounded-full ring-1 ring-black/40 dark:ring-white/60"
            :class="calendar.color ? '' : 'border border-dashed border-accented bg-default'"
            :style="calendar.color ? { backgroundColor: calendar.color } : undefined"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1 basis-48">
            <p class="font-medium wrap-anywhere">{{ calendar.name }}</p>
            <p class="text-sm text-toned wrap-anywhere">{{ summary(calendar) }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              :aria-label="t('Edit {name}', { name: calendarLabel(calendar) })"
              icon="i-lucide-pencil"
              :label="t('Edit')"
              color="neutral"
              variant="outline"
              @click="openDialog(calendar, 'details')"
            />
            <UButton
              :aria-label="t('Access for {name}', { name: calendarLabel(calendar) })"
              icon="i-lucide-users"
              :label="t('Access')"
              color="neutral"
              variant="outline"
              @click="openDialog(calendar, 'access')"
            />
          </div>
        </li>
      </ul>

      <!-- One dialog for a calendar and for who may use it, as for a resource: the tabs switch. -->
      <AdminCalendarDialog
        v-model:tab="tab"
        v-model:notice="notice"
        :access="access"
        :calendar-id="openId"
        @close="openId = null"
      />

      <UModal
        :open="createOpen"
        :title="t('New calendar')"
        :description="
          t(
            'A calendar of the organization: it belongs to nobody, and nobody sees it until you give people or groups access.',
          )
        "
        @update:open="(open) => (open ? undefined : saving ? undefined : (createOpen = false))"
      >
        <template #body>
          <GroupsCalendarForm
            :busy="saving"
            cancellable
            :save="create"
            @cancel="createOpen = false"
          />
        </template>
      </UModal>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useAdminAccess, useAdminFlag } from '~/composables/useAdminAccess'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import type { CalendarFormBody } from '~/components/groups/CalendarForm.vue'
import type { AccessCalendar, CalendarOwnerKind } from '~/utils/admin/access'
import { calendarLabel, linkedCalendar, ownerKindOf } from '~/utils/admin/access'
import { N_, t, tc } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'

definePageMeta({ alias: ['/admin/access'] })
useHead({ title: () => t('Calendars') })

const router = useRouter()
const route = useRoute()
const { admin, ensure } = useAdminFlag()
const access = useAdminAccess()
const status = useLiveStatus()
const checking = ref(true)
const loaded = ref(false)
const saving = ref(false)
const notice = ref('')
// Admin › People links here with the name of a calendar to look for.
const query = ref(typeof route.query.q === 'string' ? route.query.q : '')
const kind = ref<'all' | CalendarOwnerKind>('all')
const createOpen = ref(false)
// The calendar that is open in the dialog (by id, so it follows the list), and its tab.
const openId = ref<number | null>(null)
const tab = ref<'details' | 'access'>('details')

const kindItems = computed(() => [
  { label: t('All'), value: 'all' },
  { label: t('People'), value: 'people' },
  { label: t('Organization'), value: 'organization' },
  { label: t('Groups'), value: 'groups' },
  { label: t('Resources'), value: 'resources' },
])
const calendars = computed(() => access.calendars.data.value?.calendars ?? [])
const shown = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return calendars.value.filter(
    (calendar) =>
      (kind.value === 'all' || ownerKindOf(calendar) === kind.value) &&
      (needle === '' ||
        [calendar.name, calendar.owner, calendar.group?.name].some((text) =>
          text?.toLowerCase().includes(needle),
        )),
  )
})
/** Whom the calendar belongs to, and how many rules share it. */
function summary(calendar: AccessCalendar): string {
  const owner = {
    people: calendar.owner
      ? t('Calendar of {name}', { name: calendar.owner })
      : t('Calendar of a person'),
    organization: t('Calendar of the organization'),
    groups: t('Calendar of the group {name}', { name: calendar.group?.name ?? '' }),
    resources: t('Calendar of a resource'),
  }[ownerKindOf(calendar)]
  return `${owner} · ${tc('{count} access rule | {count} access rules', calendar.rules.length)}`
}

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
  // "Edit calendar" in the sidebar's menu of a calendar opens it here: by its id (a share names
  // it), or by its path in Radicale (one's own calendar).
  const wanted = linkedCalendar(calendars.value, route.query)
  if (wanted && openId.value === null) openDialog(wanted, 'details')
}

onMounted(start)

function openDialog(calendar: AccessCalendar, which: 'details' | 'access') {
  notice.value = ''
  openId.value = calendar.id
  tab.value = which
}

/** Runs one change of the calendar; the calendar view is reloaded when it worked. */
async function run(job: () => Promise<string>, action: string): Promise<true | string> {
  if (saving.value) return t('Another change is still being saved. Try again in a moment.')
  saving.value = true
  notice.value = ''
  try {
    notice.value = await job()
    void status.refresh({ external: false })
    return true
  } catch (cause) {
    return describeError(cause, action)
  } finally {
    saving.value = false
  }
}

function create(body: CalendarFormBody): Promise<true | string> {
  return run(async () => {
    const saved = await access.createCalendar({
      name: body.name,
      ...(body.color ? { color: body.color } : {}),
    })
    createOpen.value = false
    // Nobody sees it yet: who may is what comes next.
    openId.value = saved.id
    tab.value = 'access'
    return t('{name} was added. Nobody sees it until you give people or groups access.', {
      name: saved.name,
    })
  }, N_('add the calendar'))
}
</script>
