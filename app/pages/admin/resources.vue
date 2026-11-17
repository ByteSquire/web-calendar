<!--
  Resources administration, admins only: the resources (rooms, cars, equipment), each with Edit and
  Access and an "Inactive" badge where it applies. "New resource" opens a dialog with the form; a
  new resource is listed, a toast says that everyone signed in can book it, and its dialog opens on
  "Access", since choosing who manages it comes next (administrators are not managers by default,
  so nobody could accept a request). A refusal keeps the new-resource dialog open with the field
  messages and the reason (and a toast). Changing, deactivating, reactivating and deleting a
  resource, and its rules, happen in its dialog, the same one "Edit resource" in the sidebar opens;
  the page follows its `saved` and `deleted`. Focus returns to what opened a dialog; when that is
  gone (the form of a new resource, a deleted row) it goes to the Edit button of the resource that
  was open, else to "New resource". A resource with bookings, past ones included, is not deleted
  (the server refuses it); deactivating it stops new bookings instead. Only a failed load is told
  on the page, with Retry, so nothing above the list comes and goes. The page checks `/api/me` and
  sends everybody else back to the calendar; that is only tidiness, the admin routes refuse
  non-admins themselves. After each change the calendar data is reloaded so the sidebar and the
  booking form show it. `?open=<id>` (from "Edit resource" in the sidebar) opens that resource's
  dialog.
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
      <p>{{ t('Rooms, cars and equipment that people can book.') }}</p>

      <SettingsErrorAlert v-if="loadError" :message="loadError" retryable @retry="start()" />

      <div class="flex flex-wrap items-end gap-3">
        <UButton
          ref="newButton"
          :label="t('New resource')"
          icon="i-lucide-plus"
          :disabled="!loaded"
          @click="openCreate"
        />
      </div>

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
              :data-edit-resource="resource.id"
              icon="i-lucide-pencil"
              :label="t('Edit')"
              color="neutral"
              variant="outline"
              @click="openDialog(resource, 'details')"
            />
            <UButton
              :aria-label="t('Access for {name}', { name: resource.name })"
              icon="i-lucide-users"
              :label="t('Access')"
              color="neutral"
              variant="outline"
              @click="openDialog(resource, 'access')"
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
        :focus-fallback="focusAfterDialog"
        @close="dialog = null"
        @saved="replaceResource"
        @deleted="removeResource"
      />

      <UModal
        :open="createOpen"
        :title="t('New resource')"
        :description="t('Everyone signed in can book a new resource. Next, choose who manages it.')"
        :content="{ onOpenAutoFocus: focusCreateForm, onCloseAutoFocus: restoreAfterCreate }"
        @update:open="(open) => (open ? undefined : creating ? undefined : (createOpen = false))"
      >
        <template #body>
          <div class="flex flex-col gap-4">
            <AdminResourceForm
              ref="createForm"
              :errors="createErrors"
              :busy="creating"
              cancellable
              :save="create"
              @cancel="createOpen = false"
            />
            <SettingsErrorAlert v-if="createProblem" :message="createProblem" />
          </div>
        </template>
      </UModal>
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
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { N_, t, tc } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'
import { createFocusReturn } from '~/utils/settings/focus-return'

useHead({ title: () => t('Resources') })

type Body = NonNullable<ReturnType<typeof toBody>>

const router = useRouter()
const route = useRoute()
const { admin, ensure } = useAdminFlag()
const api = useAuthFetch()
const status = useLiveStatus()
const notify = useNotify()

const checking = ref(true)
const loaded = ref(false)
const loadError = ref<string | null>(null)
const resources = ref<AdminResource[]>([])
const users = ref<AccessUser[]>([])
/** The groups a rule can name (the Groups page's); empty when they could not be loaded. */
const groups = ref<{ name: string }[]>([])
// The dialog of a new resource: open, sending, and what the server refused last time.
const createOpen = ref(false)
const creating = ref(false)
const createProblem = ref<string | null>(null)
const createErrors = ref<Record<string, string>>({})
// The resource that is open in the dialog, and which of its two tabs is shown.
const dialog = ref<AdminResource | null>(null)
const tab = ref<'details' | 'access'>('details')
const newButton = useTemplateRef<{ $el: HTMLElement }>('newButton')
const createForm = useTemplateRef<{ focusFirst: () => void }>('createForm')
// The dialog of "New resource" gives focus back to its button, unless a new resource's dialog took
// over; the resource whose dialog was open last, for where focus goes after it.
const createFocus = createFocusReturn(() => newButton.value?.$el)
let handedOver = false
let lastOpenId: number | null = null
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

function openCreate() {
  createFocus.remember()
  handedOver = false
  // A new dialog starts clean: nothing of the last refusal is shown.
  createProblem.value = null
  createErrors.value = {}
  createOpen.value = true
}

function focusCreateForm(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  createForm.value?.focusFirst()
}

function restoreAfterCreate(event: Event) {
  // The new resource's dialog has the focus now; it hands it on when it closes.
  if (handedOver) event.preventDefault()
  else createFocus.restore(event)
}

/** After a resource's dialog, when what opened it is gone: its Edit button, else "New resource". */
function focusAfterDialog(): HTMLElement | null | undefined {
  const edit =
    lastOpenId === null
      ? null
      : document.querySelector<HTMLElement>(`[data-edit-resource="${lastOpenId}"]`)
  return edit ?? newButton.value?.$el
}

async function create(body: Body): Promise<boolean> {
  if (creating.value) return false
  creating.value = true
  createProblem.value = null
  try {
    const saved = await api<AdminResource>('/api/admin/resources', { method: 'POST', body })
    resources.value = [...resources.value, saved].sort((a, b) => a.name.localeCompare(b.name))
    createErrors.value = {}
    handedOver = true
    createOpen.value = false
    notify.done(
      t('{name} was added. Everyone signed in can book it; choose who manages it.', {
        name: saved.name,
      }),
    )
    void status.refresh({ external: false })
    // Who manages it is what comes next.
    openDialog(saved, 'access')
    return true
  } catch (cause) {
    const failure = describeResourceProblem(cause)
    createErrors.value = failure.fields
    createProblem.value = failure.message
    notify.failed(failure.message)
    return false
  } finally {
    creating.value = false
  }
}

function replaceResource(saved: AdminResource) {
  resources.value = resources.value.map((item) => (item.id === saved.id ? saved : item))
  if (dialog.value?.id === saved.id) dialog.value = saved
}

function removeResource(id: number) {
  resources.value = resources.value.filter((item) => item.id !== id)
}

function openDialog(resource: AdminResource, which: 'details' | 'access') {
  lastOpenId = resource.id
  dialog.value = resource
  tab.value = which
}
</script>
