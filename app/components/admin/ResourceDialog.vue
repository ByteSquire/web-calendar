<!--
  One resource, admins only, in a dialog with two tabs, as for an event: "Resource" changes its
  name, type, place, size and description, deactivates or reactivates it (with what that means) and
  deletes it after asking (the server refuses a resource with bookings: deactivate it then);
  "Access" says who may see, book and manage it (every rule change sends the complete list). The
  rules are loaded when the access tab is shown first. Used on Admin › Resources and from "Edit
  resource" in the sidebar's menu of a resource, so an admin changes a resource where they are; the
  holder follows through `saved` and `deleted`. Saving the details closes the dialog, as an event's
  does; deactivating, reactivating and a change of the rules keep it open. What a change came to is
  a toast, here and nowhere else, so it comes once wherever the dialog is; a failure is also told
  where it happened (below the form, in the activity part, below the rules, in the delete question).
  Nothing of it is left when the dialog closes or shows another resource. Focus returns to what
  opened it, else to `focusFallback`. After each change the calendar data is reloaded so the
  sidebar and the booking form show it. The admin routes check the caller themselves.
-->
<template>
  <UModal
    :open="resource !== null"
    :title="resource?.name ?? ''"
    :description="t('Change the resource, or choose who may use it.')"
    :ui="{ content: 'sm:max-w-2xl' }"
    :content="{ onCloseAutoFocus: focusReturn.restore }"
    @update:open="(open) => (open ? undefined : close())"
  >
    <template #body>
      <div v-if="resource" class="flex flex-col gap-4">
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
              <div class="flex flex-col gap-4">
                <AdminResourceForm
                  :key="resource.id"
                  :initial="draftOf(resource)"
                  :errors="fieldErrors"
                  :busy="saving"
                  cancellable
                  :save="saveEdit"
                  @cancel="close"
                />
                <SettingsErrorAlert v-if="problem?.at === 'details'" :message="problem.message" />
              </div>
              <section
                aria-labelledby="resource-active-heading"
                class="flex flex-col gap-2 border-t border-default pt-4"
              >
                <h3 id="resource-active-heading" class="font-semibold">
                  {{ resource.active ? t('Deactivate resource') : t('Reactivate resource') }}
                </h3>
                <p class="text-sm text-toned" data-resource-activity>
                  {{
                    resource.active
                      ? t('Deactivated resources take no new bookings; existing bookings stay.')
                      : t(
                          'This resource is deactivated: it takes no new bookings; existing bookings stay.',
                        )
                  }}
                </p>
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
                  class="self-start"
                  :loading="activating"
                  :disabled="saving"
                  @click="setActive(!resource.active)"
                />
                <SettingsErrorAlert v-if="problem?.at === 'active'" :message="problem.message" />
              </section>
              <section
                aria-labelledby="resource-delete-heading"
                class="flex flex-col gap-2 border-t border-default pt-4"
              >
                <h3 id="resource-delete-heading" class="font-semibold">
                  {{ t('Delete resource') }}
                </h3>
                <p class="text-sm text-toned">{{ deleteDetail }}</p>
                <UButton
                  :label="t('Delete resource')"
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="outline"
                  class="self-start"
                  :disabled="saving"
                  @click="askDelete"
                />
              </section>
            </div>
          </template>
          <template #access>
            <section aria-labelledby="resource-rules-heading" class="flex flex-col gap-3">
              <h3 id="resource-rules-heading" class="text-lg font-semibold">
                {{ t('Who may use {name}', { name: resource.name }) }}
              </h3>
              <SettingsErrorAlert v-if="rulesError" :message="rulesError" />
              <AdminResourceRuleList
                v-if="rules !== null"
                :rules="ruleRows"
                :resource-name="resource.name"
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
                    { name: resource.name },
                  )
                }}
              </p>
              <SettingsErrorAlert v-if="problem?.at === 'rules'" :message="problem.message" />
              <AdminAccessAddForm
                v-if="rules !== null"
                :key="resource.id"
                class="mt-1"
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
          @click="close"
        />
      </div>
    </template>
  </UModal>

  <ConfirmDeleteDialog
    :open="deleting !== null"
    :event-title="deleting?.name ?? ''"
    :detail="deleteDetail"
    :pending="saving"
    :error="deleteError"
    :return-focus-to="deleteFocus"
    @update:open="(open) => (open ? undefined : closeDelete())"
    @confirm="confirmDelete"
  />
</template>

<script setup lang="ts">
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { userLabel, type AccessUser } from '~/utils/admin/access'
import {
  RESOURCE_RIGHTS,
  describeResourceProblem,
  draftOf,
  withRule,
  withoutRule,
  type AdminResource,
  type ResourceRight,
  type ResourceRule,
  type toBody,
} from '~/utils/admin/resources'
import { N_, t, tv } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'
import { createFocusReturn } from '~/utils/settings/focus-return'

type Body = NonNullable<ReturnType<typeof toBody>>

const props = defineProps<{
  resource: AdminResource | null
  tab: 'details' | 'access'
  /** The people a rule can name: those who signed in once. */
  users: readonly AccessUser[]
  /** The groups a rule can name (the Groups page's). */
  groups: readonly { name: string }[]
  /** Where focus goes when the element that opened the dialog is gone (looked up on closing). */
  focusFallback?: () => HTMLElement | null | undefined
}>()
const emit = defineEmits<{
  close: []
  'update:tab': [tab: 'details' | 'access']
  /** The resource as the server saved it (its details, or deactivated or reactivated). */
  saved: [resource: AdminResource]
  /** The resource was deleted. */
  deleted: [id: number]
}>()

const deleteDetail = computed(() =>
  t(
    'The resource and the rules of who may use it are deleted. A resource with bookings cannot be deleted; deactivate it instead.',
  ),
)

const api = useAuthFetch()
const status = useLiveStatus()
const notify = useNotify()
const focusReturn = createFocusReturn(() => props.focusFallback?.())
const saving = ref(false)
const activating = ref(false)
// The last failed change and where it is told: below the form, the activity part or the rules.
const problem = ref<{ at: 'details' | 'active' | 'rules'; message: string } | null>(null)
const fieldErrors = ref<Record<string, string>>({})
// The rules of the resource that is open; null until they are loaded.
const rules = ref<ResourceRule[] | null>(null)
const rulesFor = ref<number | null>(null)
const rulesError = ref<string | null>(null)
// The resource whose delete is being confirmed, and why the last try failed.
const deleting = ref<AdminResource | null>(null)
const deleteError = ref('')
// Where the question sends focus when it closes: nowhere while this dialog is under it; after a
// delete, where this dialog would (both close, and the last one to go decides).
const deleteFocus = ref<HTMLElement | false | null>(false)

const tabItems = computed(() => [
  { label: t('Resource'), value: 'details', slot: 'details' },
  { label: t('Access'), value: 'access', slot: 'access' },
])
const ruleRows = computed(() => (rules.value ?? []).map((rule) => ({ rule, label: labelOf(rule) })))
const hasManager = computed(() => rules.value?.some((rule) => rule.right === 'manage') === true)

function labelOf(rule: ResourceRule): string {
  if (rule.principalType === 'authenticated') return t('Everyone signed in')
  if (rule.principalType === 'group') return t('Group {name}', { name: rule.principal ?? '' })
  const known = props.users.find((user) => user.sub === rule.principal)
  return known ? userLabel(known) : t('This person')
}

// Another resource, or closed: nothing of the last one is shown.
watch(
  () => props.resource?.id,
  (id) => {
    if (id !== undefined) focusReturn.remember()
    problem.value = null
    fieldErrors.value = {}
    rules.value = null
    rulesFor.value = null
    rulesError.value = null
    deleting.value = null
    deleteError.value = ''
  },
)

/** The rules are loaded when the access tab is shown first, not for a resource that is only edited. */
watch(
  [() => props.resource?.id, () => props.tab],
  ([id, which]) => {
    if (id !== undefined && which === 'access' && rulesFor.value !== id) void loadRules(id)
  },
  { immediate: true },
)

async function loadRules(id: number) {
  rulesFor.value = id
  rules.value = null
  rulesError.value = null
  try {
    const answer = await api<{ rules: ResourceRule[] }>(`/api/admin/resources/${id}/acl`)
    if (props.resource?.id === id) rules.value = answer.rules
  } catch (cause) {
    if (props.resource?.id === id) {
      rulesError.value = describeError(cause, N_('load the rules'))
      // Shown again next time the tab is chosen.
      rulesFor.value = null
    }
  }
}

/**
 * Runs one change and toasts what it came to; the calendar data is reloaded when it worked. A
 * failure is toasted and kept for the place `at` where it happened.
 */
async function run(
  at: 'details' | 'active' | 'rules' | 'delete',
  job: () => Promise<string>,
): Promise<{ ok: boolean; message: string; fields: Record<string, string> }> {
  if (saving.value) return { ok: false, message: '', fields: {} }
  saving.value = true
  problem.value = null
  try {
    notify.done(await job())
    void status.refresh({ external: false })
    return { ok: true, message: '', fields: {} }
  } catch (cause) {
    const failure = describeResourceProblem(cause)
    notify.failed(failure.message)
    // The delete question shows its own failure.
    if (at !== 'delete') problem.value = { at, message: failure.message }
    return { ok: false, ...failure }
  } finally {
    saving.value = false
  }
}

async function saveEdit(body: Body): Promise<boolean> {
  const target = props.resource
  if (!target) return false
  const answer: { saved?: AdminResource } = {}
  const result = await run('details', async () => {
    const saved = await api<AdminResource>(`/api/admin/resources/${target.id}`, {
      method: 'PUT',
      body,
    })
    answer.saved = saved
    return t('{name} was saved.', { name: saved.name })
  })
  fieldErrors.value = result.fields
  // As the dialog of an event does, it closes when the change is saved.
  if (result.ok && answer.saved) {
    emit('saved', answer.saved)
    emit('close')
  }
  return result.ok
}

/** Deactivates or reactivates the resource (`PUT` with `active: true`); the dialog stays open. */
async function setActive(active: boolean) {
  const target = props.resource
  if (!target) return
  activating.value = true
  await run('active', async () => {
    const saved = await api<AdminResource>(
      active ? `/api/admin/resources/${target.id}` : `/api/admin/resources/${target.id}/deactivate`,
      { method: active ? 'PUT' : 'POST', ...(active ? { body: { active: true } } : {}) },
    )
    emit('saved', saved)
    return active
      ? t('{name} is active again.', { name: saved.name })
      : t('{name} is deactivated.', { name: saved.name })
  })
  activating.value = false
}

function askDelete() {
  deleteError.value = ''
  deleteFocus.value = false
  deleting.value = props.resource
}

function closeDelete() {
  if (!saving.value) deleting.value = null
}

async function confirmDelete() {
  const target = deleting.value
  if (!target) return
  const result = await run('delete', async () => {
    await api(`/api/admin/resources/${target.id}`, { method: 'DELETE' })
    return t('{name} was deleted.', { name: target.name })
  })
  if (result.ok) {
    emit('deleted', target.id)
    // The row of the resource is gone once the page has drawn the list again.
    await nextTick()
    deleteFocus.value = props.focusFallback?.() ?? null
    deleting.value = null
    emit('close')
  } else {
    // The reason belongs in the question, not behind it.
    deleteError.value = result.message
  }
}

async function saveRules(next: ResourceRule[], done: string): Promise<boolean> {
  const target = props.resource
  if (!target) return false
  const result = await run('rules', async () => {
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

function close() {
  // Not while a change is on its way: its answer belongs to this dialog.
  if (!saving.value) emit('close')
}
</script>
