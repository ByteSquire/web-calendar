<!--
  One calendar, admins only, in a dialog with two tabs, as for a resource: "Details" renames it,
  changes its own colour (everybody sees it who has not picked their own) and deletes it (after
  asking; a person's default calendar and a resource's calendar are not deleted here); "Who has
  access" shows the links to it (FR-26a) and its access rules, whether the calendar server has each
  rule yet, and adds and removes them (every change sends the complete rule list). Used on Admin ›
  Calendars and from "Edit calendar" in the sidebar's menu of a calendar, so an admin changes a
  calendar where they are. It works on the list of `access`, so the page that holds it follows each
  change; after each change the calendar view is reloaded. The admin routes check the caller.
-->
<template>
  <UModal
    :open="calendar !== null"
    :title="calendar ? calendarLabel(calendar) : ''"
    :description="t('Change the calendar, or choose who may see or change it.')"
    :ui="{ content: 'sm:max-w-2xl', title: 'wrap-anywhere' }"
    @update:open="(open) => (open ? undefined : close())"
  >
    <template #body>
      <div v-if="calendar" class="flex flex-col gap-4">
        <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>
        <UTabs
          :model-value="tab"
          :items="tabItems"
          :unmount-on-hide="false"
          :ui="{ trigger: 'min-h-11 data-[state=inactive]:text-toned' }"
          class="w-full"
          @update:model-value="(value) => emit('update:tab', value as 'details' | 'access')"
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
                :key="`details-${calendar.id}`"
                :initial="calendar"
                :busy="saving"
                cancellable
                :save="saveDetails"
                @cancel="close"
              />
              <section
                aria-labelledby="calendar-delete-heading"
                class="flex flex-col gap-2 border-t border-default pt-4"
              >
                <h3 id="calendar-delete-heading" class="font-semibold">
                  {{ t('Delete calendar') }}
                </h3>
                <p v-if="calendar.isDefault" class="text-sm text-toned" data-default-calendar>
                  {{
                    t(
                      'This is the default calendar of {name}. It is kept, so they always have a calendar to write to: it can be renamed, not deleted.',
                      { name: calendar.owner ?? t('a person') },
                    )
                  }}
                </p>
                <p v-else-if="calendar.kind === 'resource'" class="text-sm text-toned">
                  {{
                    t('A resource calendar is deleted with its resource, on the Resources page.')
                  }}
                </p>
                <template v-else>
                  <p class="text-sm text-toned">{{ deleteDetail(calendar) }}</p>
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
              :aria-label="t('Who has access to {name}', { name: calendar.name })"
              class="flex flex-col gap-3"
            >
              <LinksCalendarLinks
                :key="calendar.id"
                :title="t('Links')"
                :calendar-id="calendar.id"
                :calendar-name="calendar.name"
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
              <p v-if="calendar.owner" class="text-toned">
                {{ t('Owner: {name} (always has full access).', { name: calendar.owner }) }}
              </p>
              <p v-else-if="ownerKindOf(calendar) === 'organization'" class="text-toned">
                {{
                  t(
                    'This calendar belongs to the organization: only the people and groups below see it.',
                  )
                }}
              </p>
              <SettingsErrorAlert v-if="problem" :message="problem" />
              <AdminAccessRuleList
                :rules="calendar.rules"
                :calendar-name="calendar.name"
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
          @click="close"
        />
      </div>
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

<script setup lang="ts">
import { principalLabel } from '~/utils/principal-label'
import type { AdminAccess } from '~/composables/useAdminAccess'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import type { CalendarFormBody } from '~/components/groups/CalendarForm.vue'
import type { AccessCalendar, AccessRule, AccessRuleInput } from '~/utils/admin/access'
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

const props = defineProps<{
  /** The calendars, people and groups of the access administration, and its changes. */
  access: AdminAccess
  /** The calendar that is open, by id, so it follows the list; null for none. */
  calendarId: number | null
  tab: 'details' | 'access'
  /** What the last change came to, shown in the dialog (a page may set it on opening). */
  notice: string
}>()
const emit = defineEmits<{
  close: []
  'update:tab': [tab: 'details' | 'access']
  'update:notice': [notice: string]
  /** The calendar was deleted; the words for it, for whoever shows them now. */
  deleted: [message: string]
}>()

const status = useLiveStatus()
const saving = ref(false)
const problem = ref<string | null>(null)
const deleting = ref<AccessCalendar | null>(null)
const deleteError = ref('')

const tabItems = computed(() => [
  { label: t('Details'), value: 'details', slot: 'details' },
  { label: t('Who has access'), value: 'access', slot: 'access' },
])
const calendar = computed(
  () =>
    props.access.calendars.data.value?.calendars.find((item) => item.id === props.calendarId) ??
    null,
)
const pendingCount = computed(
  () => calendar.value?.rules.filter((rule) => !rule.applied).length ?? 0,
)

// Another calendar: no problem of the last one is shown.
watch(
  () => props.calendarId,
  () => {
    problem.value = null
  },
)

const setNotice = (text: string) => emit('update:notice', text)

function deleteDetail(target: AccessCalendar): string {
  if (ownerKindOf(target) === 'people') {
    return t(
      'The calendar of {name} and all its events are deleted, the people it is shared with lose it, and its links stop working.',
      { name: target.owner ?? t('a person') },
    )
  }
  return t(
    'The calendar and all its events are deleted for everybody who has it, and its links stop working.',
  )
}

function close() {
  // Not while a change is on its way: its answer belongs to this dialog.
  if (!saving.value) emit('close')
}

/** Runs one change of the calendar; the calendar view is reloaded when it worked. */
async function run(job: () => Promise<string>, action: string): Promise<true | string> {
  if (saving.value) return t('Another change is still being saved. Try again in a moment.')
  saving.value = true
  problem.value = null
  setNotice('')
  try {
    setNotice(await job())
    void status.refresh({ external: false })
    return true
  } catch (cause) {
    return describeError(cause, action)
  } finally {
    saving.value = false
  }
}

function saveDetails(body: CalendarFormBody): Promise<true | string> {
  const target = calendar.value
  if (!target) return Promise.resolve(t('This calendar no longer exists. Reload the page.'))
  return run(async () => {
    const saved = await props.access.changeCalendar(target.id, body)
    return t('{name} was saved.', { name: saved.name })
  }, N_('save the calendar'))
}

function askDelete() {
  deleteError.value = ''
  deleting.value = calendar.value
}

function closeDelete() {
  if (!saving.value) deleting.value = null
}

async function confirmDelete() {
  const target = deleting.value
  if (!target) return
  const message = t('{name} was deleted.', { name: calendarLabel(target) })
  const answer = await run(async () => {
    await props.access.deleteCalendar(target.id)
    return message
  }, N_('delete the calendar'))
  if (answer === true) {
    deleting.value = null
    emit('deleted', message)
    emit('close')
  } else {
    deleteError.value = answer
  }
}

function labelOf(rule: AccessRuleInput): string {
  if (rule.principalType === 'authenticated') return t('Everyone signed in')
  if (rule.principalType === 'group') return t('Group {name}', { name: rule.principal ?? '' })
  const known = calendar.value?.rules.find((item) => item.principal === rule.principal)
  return known ? principalLabel(known.principalType, known.label) : t('This person')
}

async function change(rules: AccessRuleInput[], done: string): Promise<boolean> {
  const target = calendar.value
  if (!target || saving.value) return false
  saving.value = true
  problem.value = null
  setNotice('')
  const result = await props.access.saveRules(target.id, rules, labelOf)
  saving.value = false
  if (result.ok) setNotice(done)
  else problem.value = result.message
  return result.ok
}

function add(rule: AccessRuleInput, label: string): Promise<boolean> {
  const target = calendar.value
  if (!target) return Promise.resolve(false)
  return change(
    withRule(target.rules, rule),
    t('Access for {label} is now: {level}.', { label, level: levelLabel(rule.permission) }),
  )
}

function remove(rule: AccessRule) {
  const target = calendar.value
  if (!target) return
  void change(
    withoutRule(target.rules, rule.id),
    t('{label} no longer has access.', { label: principalLabel(rule.principalType, rule.label) }),
  )
}
</script>
