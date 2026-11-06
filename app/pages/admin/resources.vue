<!--
  Resources administration, admins only: add, change, deactivate and delete resources (rooms, cars,
  equipment) and say who may see, book and manage each. A resource with bookings, past ones
  included, is not deleted (the server refuses it); deactivating it stops new bookings instead. The page checks `/api/me` and sends
  everybody else back to the calendar; that is only tidiness, the admin routes refuse non-admins
  themselves. Administrators are not managers by default, so the rules of a new resource must name
  somebody with "Can manage" or nobody can accept a request. Every rule change sends the complete
  rule list. After each change the calendar data is reloaded so the sidebar and the booking form
  show it. `?open=<id>` (from "Edit resource" in the sidebar) opens that resource's dialog.
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
            <UButton
              :aria-label="t('Delete {name}', { name: resource.name })"
              icon="i-lucide-trash-2"
              :label="t('Delete')"
              color="neutral"
              variant="outline"
              :disabled="saving"
              @click="askDelete(resource)"
            />
          </div>
        </li>
      </ul>

      <!-- One dialog for a resource and for who may use it, as for an event: the tabs switch. -->
      <AdminResourceDialog
        v-model:tab="tab"
        :resource="dialog"
        :users="users"
        :groups="groups"
        @close="dialog = null"
        @saved="onSaved"
      />

      <ConfirmDeleteDialog
        :open="deleting !== null"
        :event-title="deleting?.name ?? ''"
        :detail="
          t(
            'The resource and the rules of who may use it are deleted. A resource with bookings cannot be deleted; deactivate it instead.',
          )
        "
        :pending="saving"
        :error="deleteError"
        :return-focus-to="false"
        @update:open="(open) => (open ? undefined : saving ? undefined : (deleting = null))"
        @confirm="confirmDelete"
      />

      <AdminResourceForm v-if="loaded" :errors="createErrors" :busy="saving" :save="create" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useAdminFlag } from '~/composables/useAdminAccess'
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import type { AccessUser } from '~/utils/admin/access'
import {
  describeResourceProblem,
  typeLabel,
  type AdminResource,
  type toBody,
} from '~/utils/admin/resources'
import { N_, t, tc } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'

useHead({ title: () => t('Resources') })

type Body = NonNullable<ReturnType<typeof toBody>>

const router = useRouter()
const route = useRoute()
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
const createErrors = ref<Record<string, string>>({})
// The resource that is open in the dialog, and which of its two tabs is shown.
const dialog = ref<AdminResource | null>(null)
const tab = ref<'details' | 'access'>('details')
// The resource whose delete is being confirmed, and why the last try failed.
const deleting = ref<AdminResource | null>(null)
const deleteError = ref('')
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
    // "Edit resource" in the sidebar's menu of a resource opens it here.
    const wanted = resources.value.find((item) => String(item.id) === route.query.open)
    if (wanted && dialog.value === null) openDialog(wanted, 'details')
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

function askDelete(resource: AdminResource) {
  deleteError.value = ''
  deleting.value = resource
}

async function confirmDelete() {
  const target = deleting.value
  if (!target) return
  const result = await run(async () => {
    await api(`/api/admin/resources/${target.id}`, { method: 'DELETE' })
    resources.value = resources.value.filter((item) => item.id !== target.id)
    return t('{name} was deleted.', { name: target.name })
  })
  if (result.ok) {
    deleting.value = null
  } else {
    // The reason belongs in the dialog, not behind it.
    deleteError.value = problem.value ?? ''
    problem.value = null
  }
}

function openDialog(resource: AdminResource, which: 'details' | 'access') {
  problem.value = null
  notice.value = ''
  dialog.value = resource
  tab.value = which
}

function onSaved(saved: AdminResource, message: string) {
  replaceResource(saved)
  notice.value = message
  void status.refresh({ external: false })
}
</script>
