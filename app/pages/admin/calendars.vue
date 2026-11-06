<!--
  Admin › Calendars (FR-14), admins only: every calendar of the app, people's, the organization's,
  the groups' and the resources', with a filter by whom they belong to and a search. A calendar
  opens in one dialog with two tabs, as a resource does: "Details" renames it, changes its own colour
  (everybody sees it who has not picked their own) and deletes it; "Who has access" shows the links
  to it (FR-26a) and its access rules, whether the calendar server has each rule yet, and adds and
  removes them (every change sends the complete rule list). "New calendar" makes a calendar of the
  organization, which belongs to nobody, so nobody sees it until a rule shares it: the dialog then
  opens on "Who has access". A resource's calendar is deleted with its resource, on Admin ›
  Resources, and a person's default calendar is not deleted at all (they always keep one). The page checks `/api/me` and sends everybody else back to the calendar; that is only
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
      <p v-if="!dialog" role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>

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
      <UModal
        :open="dialog !== null"
        :title="dialog ? calendarLabel(dialog) : ''"
        :description="t('Change the calendar, or choose who may see or change it.')"
        :ui="{ content: 'sm:max-w-2xl', title: 'wrap-anywhere' }"
        @update:open="(open) => (open ? undefined : closeDialog())"
      >
        <template #body>
          <div v-if="dialog" class="flex flex-col gap-4">
            <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>
            <UTabs
              v-model="tab"
              :items="tabItems"
              :unmount-on-hide="false"
              :ui="{ trigger: 'min-h-11 data-[state=inactive]:text-toned' }"
              class="w-full"
            >
              <template #details>
                <div class="flex flex-col gap-6">
                  <p class="text-sm text-toned">
                    {{
                      t(
                        'The name and colour are the calendar’s own: everybody who has the calendar sees them, unless they picked a colour of their own.',
                      )
                    }}
                  </p>
                  <GroupsCalendarForm
                    :key="`details-${dialog.id}`"
                    :initial="dialog"
                    :busy="saving"
                    cancellable
                    :save="saveDetails"
                    @cancel="closeDialog"
                  />
                  <section
                    aria-labelledby="calendar-delete-heading"
                    class="flex flex-col gap-2 border-t border-default pt-4"
                  >
                    <h3 id="calendar-delete-heading" class="font-semibold">
                      {{ t('Delete calendar') }}
                    </h3>
                    <p v-if="dialog.isDefault" class="text-sm text-toned" data-default-calendar>
                      {{
                        t(
                          'This is the default calendar of {name}. It is kept, so they always have a calendar to write to: it can be renamed, not deleted.',
                          { name: dialog.owner ?? t('a person') },
                        )
                      }}
                    </p>
                    <p v-else-if="dialog.kind === 'resource'" class="text-sm text-toned">
                      {{
                        t(
                          'A resource calendar is deleted with its resource, on the Resources page.',
                        )
                      }}
                    </p>
                    <template v-else>
                      <p class="text-sm text-toned">{{ deleteDetail(dialog) }}</p>
                      <UButton
                        :label="t('Delete calendar')"
                        icon="i-lucide-trash-2"
                        color="error"
                        variant="outline"
                        class="self-start"
                        :disabled="saving"
                        @click="askDelete"
                      />
                    </template>
                  </section>
                </div>
              </template>
              <template #access>
                <section
                  :aria-label="t('Who has access to {name}', { name: dialog.name })"
                  class="flex flex-col gap-3"
                >
                  <LinksCalendarLinks
                    :key="dialog.id"
                    :title="t('Links')"
                    :calendar-id="dialog.id"
                    :calendar-name="dialog.name"
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
                  <p v-if="dialog.owner" class="text-toned">
                    {{ t('Owner: {name} (always has full access).', { name: dialog.owner }) }}
                  </p>
                  <p v-else-if="ownerKindOf(dialog) === 'organization'" class="text-toned">
                    {{
                      t(
                        'This calendar belongs to the organization: only the people and groups below see it.',
                      )
                    }}
                  </p>
                  <SettingsErrorAlert v-if="problem" :message="problem" />
                  <AdminAccessRuleList
                    :rules="dialog.rules"
                    :calendar-name="dialog.name"
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
                </section>
                <AdminAccessAddForm
                  class="mt-4"
                  :users="access.users.data.value ?? []"
                  :groups="access.groups.data.value ?? []"
                  :busy="saving"
                  :levels="ACCESS_LEVELS"
                  default-level="read"
                  :save="add"
                />
              </template>
            </UTabs>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end">
            <UButton
              :label="t('Close')"
              color="neutral"
              variant="outline"
              :disabled="saving"
              @click="closeDialog"
            />
          </div>
        </template>
      </UModal>

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

      <ConfirmDeleteDialog
        :open="deleting !== null"
        :event-title="deleting ? calendarLabel(deleting) : ''"
        :detail="deleting ? deleteDetail(deleting) : ''"
        :pending="saving"
        :error="deleteError"
        :return-focus-to="false"
        @update:open="(open) => (open ? undefined : closeDelete())"
        @confirm="confirmDelete"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { principalLabel } from '~/utils/principal-label'
import { useAdminAccess, useAdminFlag } from '~/composables/useAdminAccess'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import type { CalendarFormBody } from '~/components/groups/CalendarForm.vue'
import type {
  AccessCalendar,
  AccessRule,
  AccessRuleInput,
  CalendarOwnerKind,
} from '~/utils/admin/access'
import {
  ACCESS_LEVELS,
  calendarLabel,
  levelLabel,
  ownerKindOf,
  withRule,
  withoutRule,
} from '~/utils/admin/access'
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
const problem = ref<string | null>(null)
const notice = ref('')
// Admin › People links here with the name of a calendar to look for.
const query = ref(typeof route.query.q === 'string' ? route.query.q : '')
const kind = ref<'all' | CalendarOwnerKind>('all')
const createOpen = ref(false)
const deleting = ref<AccessCalendar | null>(null)
const deleteError = ref('')
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
const tabItems = computed(() => [
  { label: t('Details'), value: 'details', slot: 'details' },
  { label: t('Who has access'), value: 'access', slot: 'access' },
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
const dialog = computed(() => calendars.value.find((item) => item.id === openId.value) ?? null)
const pendingCount = computed(() => dialog.value?.rules.filter((rule) => !rule.applied).length ?? 0)

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

function deleteDetail(calendar: AccessCalendar): string {
  if (ownerKindOf(calendar) === 'people') {
    return t(
      'The calendar of {name} and all its events are deleted, the people it is shared with lose it, and its links stop working.',
      { name: calendar.owner ?? t('a person') },
    )
  }
  return t(
    'The calendar and all its events are deleted for everybody who has it, and its links stop working.',
  )
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
}

onMounted(start)

function openDialog(calendar: AccessCalendar, which: 'details' | 'access') {
  problem.value = null
  notice.value = ''
  openId.value = calendar.id
  tab.value = which
}

function closeDialog() {
  // Not while a change is on its way: its answer belongs to this dialog.
  if (saving.value) return
  openId.value = null
}

/** Runs one change of the calendar; the calendar view is reloaded when it worked. */
async function run(job: () => Promise<string>, action: string): Promise<true | string> {
  if (saving.value) return t('Another change is still being saved. Try again in a moment.')
  saving.value = true
  problem.value = null
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

function saveDetails(body: CalendarFormBody): Promise<true | string> {
  const target = dialog.value
  if (!target) return Promise.resolve(t('This calendar no longer exists. Reload the page.'))
  return run(async () => {
    const saved = await access.changeCalendar(target.id, body)
    return t('{name} was saved.', { name: saved.name })
  }, N_('save the calendar'))
}

function askDelete() {
  deleteError.value = ''
  deleting.value = dialog.value
}

function closeDelete() {
  if (!saving.value) deleting.value = null
}

async function confirmDelete() {
  const target = deleting.value
  if (!target) return
  const answer = await run(async () => {
    await access.deleteCalendar(target.id)
    return t('{name} was deleted.', { name: calendarLabel(target) })
  }, N_('delete the calendar'))
  if (answer === true) {
    deleting.value = null
    openId.value = null
  } else {
    deleteError.value = answer
  }
}

function labelOf(rule: AccessRuleInput): string {
  if (rule.principalType === 'authenticated') return t('Everyone signed in')
  if (rule.principalType === 'group') return t('Group {name}', { name: rule.principal ?? '' })
  const known = dialog.value?.rules.find((item) => item.principal === rule.principal)
  return known ? principalLabel(known.principalType, known.label) : t('This person')
}

async function change(rules: AccessRuleInput[], done: string): Promise<boolean> {
  const calendar = dialog.value
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
  const calendar = dialog.value
  if (!calendar) return Promise.resolve(false)
  return change(
    withRule(calendar.rules, rule),
    t('Access for {label} is now: {level}.', { label, level: levelLabel(rule.permission) }),
  )
}

function remove(rule: AccessRule) {
  const calendar = dialog.value
  if (!calendar) return
  void change(
    withoutRule(calendar.rules, rule.id),
    t('{label} no longer has access.', { label: principalLabel(rule.principalType, rule.label) }),
  )
}
</script>
