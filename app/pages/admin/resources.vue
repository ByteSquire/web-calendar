<!--
  Resources administration, admins only: add, change and deactivate resources (rooms, cars,
  equipment) and say who may see, book and manage each. The page checks `/api/me` and sends
  everybody else back to the calendar; that is only tidiness, the admin routes refuse non-admins
  themselves. Administrators are not managers by default, so the rules of a new resource must name
  somebody with "Can manage" or nobody can accept a request. Every rule change sends the complete
  rule list. After each change the calendar data is reloaded so the sidebar and the booking form
  show it.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to calendar') }}
      </NuxtLink>
      <h1 class="text-2xl font-semibold">{{ t('Resources') }}</h1>
    </header>

    <div v-if="checking" role="status" class="flex flex-col gap-2">
      <span class="sr-only">{{ t('Checking your permissions') }}</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <SettingsErrorAlert
      v-else-if="admin === null"
      :message="t('Could not check whether you may manage resources. Try again.')"
      retryable
      @retry="start()"
    />

    <template v-else-if="admin">
      <p>
        {{
          t(
            'Rooms, cars and equipment that people can book. Deactivated resources take no new bookings; existing bookings stay.',
          )
        }}
      </p>

      <SettingsErrorAlert v-if="loadError" :message="loadError" retryable @retry="start()" />
      <SettingsErrorAlert v-if="problem" :message="problem" />
      <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>

      <p v-if="loaded && resources.length === 0" data-resource-none class="text-toned">
        {{ t('There are no resources yet.') }}
      </p>

      <ul v-if="resources.length > 0" :aria-label="t('Resources')" class="flex flex-col gap-2">
        <li
          v-for="resource in resources"
          :key="resource.id"
          data-resource
          class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
        >
          <div class="min-w-0 flex-1 basis-48">
            <p class="font-medium wrap-anywhere">{{ resource.name }}</p>
            <p class="text-sm text-toned wrap-anywhere">{{ summary(resource) }}</p>
          </div>
          <UBadge
            v-if="!resource.active"
            :label="t('Inactive')"
            icon="i-lucide-pause"
            color="neutral"
            variant="outline"
          />
          <div class="flex flex-wrap gap-2">
            <UButton
              :aria-label="t('Edit {name}', { name: resource.name })"
              icon="i-lucide-pencil"
              :label="t('Edit')"
              color="neutral"
              variant="outline"
              :disabled="saving"
              @click="openDialog(resource, 'details')"
            />
            <UButton
              :aria-label="t('Access for {name}', { name: resource.name })"
              icon="i-lucide-users"
              :label="t('Access')"
              color="neutral"
              variant="outline"
              :disabled="saving"
              @click="openDialog(resource, 'access')"
            />
            <UButton
              :aria-label="
                resource.active
                  ? t('Deactivate {name}', { name: resource.name })
                  : t('Reactivate {name}', { name: resource.name })
              "
              :icon="resource.active ? 'i-lucide-pause' : 'i-lucide-play'"
              :label="resource.active ? t('Deactivate') : t('Reactivate')"
              color="neutral"
              variant="outline"
              :disabled="saving"
              @click="setActive(resource, !resource.active)"
            />
          </div>
        </li>
      </ul>

      <!-- One dialog for a resource and for who may use it, as for an event: the tabs switch. -->
      <UModal
        :open="dialog !== null"
        :title="dialog?.name ?? ''"
        :description="t('Change the resource, or choose who may use it.')"
        :ui="{ content: 'sm:max-w-2xl' }"
        @update:open="(open) => (open ? undefined : closeDialog())"
      >
        <template #body>
          <div v-if="dialog" class="flex flex-col gap-4">
            <SettingsErrorAlert v-if="problem" :message="problem" />
            <p role="status" aria-live="polite" class="min-h-5 text-sm">{{ notice }}</p>
            <UTabs
              v-model="tab"
              :items="tabItems"
              :unmount-on-hide="false"
              :ui="{ trigger: 'min-h-11 data-[state=inactive]:text-toned' }"
              class="w-full"
            >
              <template #details>
                <AdminResourceForm
                  :key="dialog.id"
                  :initial="draftOf(dialog)"
                  :errors="fieldErrors"
                  :busy="saving"
                  cancellable
                  :save="saveEdit"
                  @cancel="closeDialog"
                />
              </template>
              <template #access>
                <section aria-labelledby="resource-rules-heading" class="flex flex-col gap-3">
                  <h3 id="resource-rules-heading" class="text-lg font-semibold">
                    {{ t('Who may use {name}', { name: dialog.name }) }}
                  </h3>
                  <SettingsErrorAlert v-if="rulesError" :message="rulesError" />
                  <AdminResourceRuleList
                    v-if="rules !== null"
                    :rules="ruleRows"
                    :resource-name="dialog.name"
                    :busy="saving"
                    @remove="removeRule"
                  />
                  <p
                    v-if="rules !== null && !hasManager"
                    data-resource-no-manager
                    class="text-sm text-toned"
                  >
                    {{
                      t(
                        'Nobody can manage {name} yet, so nobody can accept booking requests. Administrators are not managers by default.',
                        { name: dialog.name },
                      )
                    }}
                  </p>
                  <AdminAccessAddForm
                    v-if="rules !== null"
                    :users="users"
                    :groups="groups"
                    :busy="saving"
                    :levels="RESOURCE_RIGHTS"
                    default-level="book"
                    :save="addRule"
                  />
                </section>
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

      <AdminResourceForm v-if="loaded" :errors="createErrors" :busy="saving" :save="create" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useAdminFlag } from '~/composables/useAdminAccess'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { userLabel, type AccessUser } from '~/utils/admin/access'
import {
  RESOURCE_RIGHTS,
  describeResourceProblem,
  draftOf,
  typeLabel,
  withRule,
  withoutRule,
  type AdminResource,
  type ResourceRight,
  type ResourceRule,
  type toBody,
} from '~/utils/admin/resources'
import { N_, t, tc, tv } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'

useHead({ title: () => t('Resources') })

type Body = NonNullable<ReturnType<typeof toBody>>

const router = useRouter()
const { admin, ensure } = useAdminFlag()
const api = useAuthFetch()
const status = useLiveStatus()

const checking = ref(true)
const loaded = ref(false)
const loadError = ref<string | null>(null)
const resources = ref<AdminResource[]>([])
const users = ref<AccessUser[]>([])
/** The groups a rule can name (the Groups page's); empty when they could not be loaded. */
const groups = ref<{ name: string }[]>([])
const saving = ref(false)
const problem = ref<string | null>(null)
const notice = ref('')
const fieldErrors = ref<Record<string, string>>({})
const createErrors = ref<Record<string, string>>({})
// The resource that is open in the dialog, and which of its two tabs is shown.
const dialog = ref<AdminResource | null>(null)
const tab = ref<'details' | 'access'>('details')
const tabItems = computed(() => [
  { label: t('Resource'), value: 'details', slot: 'details' },
  { label: t('Access'), value: 'access', slot: 'access' },
])
// The rules of the resource that is open; null until they are loaded.
const rules = ref<ResourceRule[] | null>(null)
const rulesFor = ref<number | null>(null)
const rulesError = ref<string | null>(null)

const ruleRows = computed(() => (rules.value ?? []).map((rule) => ({ rule, label: labelOf(rule) })))
const hasManager = computed(() => rules.value?.some((rule) => rule.right === 'manage') === true)

function labelOf(rule: ResourceRule): string {
  if (rule.principalType === 'authenticated') return t('Everyone signed in')
  if (rule.principalType === 'group') return t('Group {name}', { name: rule.principal ?? '' })
  const known = users.value.find((user) => user.sub === rule.principal)
  return known ? userLabel(known) : t('This person')
}

function summary(resource: AdminResource): string {
  return [
    typeLabel(resource.type),
    resource.location,
    resource.capacity === null ? null : tc('{count} place | {count} places', resource.capacity),
  ]
    .filter(Boolean)
    .join(' · ')
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
  try {
    const [list, people, known] = await Promise.all([
      api<{ resources: AdminResource[] }>('/api/admin/resources'),
      api<{ users: AccessUser[] }>('/api/admin/access/users').catch(() => ({ users: [] })),
      api<{ groups: { name: string }[] }>('/api/groups').catch(() => ({ groups: [] })),
    ])
    resources.value = list.resources
    users.value = people.users
    groups.value = known.groups
    loadError.value = null
    loaded.value = true
  } catch (cause) {
    loadError.value = describeError(cause, N_('load the resources'))
  }
}

onMounted(start)

/** Runs one change; the calendar data is reloaded when it worked. */
async function run(
  job: () => Promise<string>,
): Promise<{ ok: boolean; fields: Record<string, string> }> {
  if (saving.value) return { ok: false, fields: {} }
  saving.value = true
  problem.value = null
  notice.value = ''
  try {
    notice.value = await job()
    void status.refresh({ external: false })
    return { ok: true, fields: {} }
  } catch (cause) {
    const failure = describeResourceProblem(cause)
    problem.value = failure.message
    return { ok: false, fields: failure.fields }
  } finally {
    saving.value = false
  }
}

function replaceResource(saved: AdminResource) {
  resources.value = resources.value.map((item) => (item.id === saved.id ? saved : item))
  if (dialog.value?.id === saved.id) dialog.value = saved
}

async function create(body: Body): Promise<boolean> {
  const result = await run(async () => {
    const saved = await api<AdminResource>('/api/admin/resources', { method: 'POST', body })
    resources.value = [...resources.value, saved].sort((a, b) => a.name.localeCompare(b.name))
    return t('{name} was added. Everyone signed in can book it; choose who manages it.', {
      name: saved.name,
    })
  })
  createErrors.value = result.fields
  return result.ok
}

async function saveEdit(body: Body): Promise<boolean> {
  const target = dialog.value
  if (!target) return false
  const result = await run(async () => {
    const saved = await api<AdminResource>(`/api/admin/resources/${target.id}`, {
      method: 'PUT',
      body,
    })
    replaceResource(saved)
    return t('{name} was saved.', { name: saved.name })
  })
  fieldErrors.value = result.fields
  // As the dialog of an event does, it closes when the change is saved.
  if (result.ok) closeDialog()
  return result.ok
}

async function setActive(resource: AdminResource, active: boolean) {
  await run(async () => {
    const saved = await api<AdminResource>(
      active
        ? `/api/admin/resources/${resource.id}`
        : `/api/admin/resources/${resource.id}/deactivate`,
      { method: active ? 'PUT' : 'POST', ...(active ? { body: { active: true } } : {}) },
    )
    replaceResource(saved)
    return active
      ? t('{name} is active again.', { name: saved.name })
      : t('{name} is deactivated.', { name: saved.name })
  })
}

function openDialog(resource: AdminResource, which: 'details' | 'access') {
  fieldErrors.value = {}
  problem.value = null
  notice.value = ''
  rules.value = null
  rulesFor.value = null
  rulesError.value = null
  dialog.value = resource
  tab.value = which
}

function closeDialog() {
  // Not while a change is on its way: its answer belongs to this dialog.
  if (saving.value) return
  dialog.value = null
  rules.value = null
  rulesFor.value = null
}

/** The rules are loaded when the access tab is shown first, not for a resource that is only edited. */
watch([() => dialog.value?.id, tab], ([id, which]) => {
  if (id !== undefined && which === 'access' && rulesFor.value !== id) void loadRules(id)
})

async function loadRules(id: number) {
  rulesFor.value = id
  rules.value = null
  rulesError.value = null
  try {
    const answer = await api<{ rules: ResourceRule[] }>(`/api/admin/resources/${id}/acl`)
    if (dialog.value?.id === id) rules.value = answer.rules
  } catch (cause) {
    if (dialog.value?.id === id) {
      rulesError.value = describeError(cause, N_('load the rules'))
      // Shown again next time the tab is chosen.
      rulesFor.value = null
    }
  }
}

async function saveRules(next: ResourceRule[], done: string): Promise<boolean> {
  const target = dialog.value
  if (!target) return false
  const result = await run(async () => {
    const saved = await api<{ rules: ResourceRule[] }>(`/api/admin/resources/${target.id}/acl`, {
      method: 'PUT',
      body: { rules: next },
    })
    rules.value = saved.rules
    return done
  })
  return result.ok
}

function addRule(
  rule: {
    principalType: ResourceRule['principalType']
    principal: string | null
    permission: ResourceRight
  },
  label: string,
): Promise<boolean> {
  const next: ResourceRule = {
    principalType: rule.principalType,
    principal: rule.principal,
    right: rule.permission,
  }
  return saveRules(
    withRule(rules.value ?? [], next),
    t('{label} can now: {right}.', {
      label,
      right: tv(
        RESOURCE_RIGHTS.find((item) => item.value === next.right)?.label ?? '',
      ).toLowerCase(),
    }),
  )
}

function removeRule(rule: ResourceRule) {
  void saveRules(
    withoutRule(rules.value ?? [], rule),
    t('{label} no longer has access.', { label: labelOf(rule) }),
  )
}
</script>
