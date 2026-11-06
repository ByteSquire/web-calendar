<!--
  One resource, admins only, in a dialog with two tabs, as for an event: "Resource" changes its
  name, type, place, size and description, "Access" says who may see, book and manage it (every
  rule change sends the complete list). The rules are loaded when the access tab is shown first.
  Used on Admin › Resources and from "Edit resource" in the sidebar's menu of a resource, so an
  admin changes a resource where they are. Saving the details closes the dialog, as an event's does;
  a change of the rules keeps it open. After each change the calendar data is reloaded so the
  sidebar and the booking form show it. The admin routes check the caller themselves.
-->
<template>
  <UModal
    :open="resource !== null"
    :title="resource?.name ?? ''"
    :description="t('Change the resource, or choose who may use it.')"
    :ui="{ content: 'sm:max-w-2xl' }"
    @update:open="(open) => (open ? undefined : close())"
  >
    <template #body>
      <div v-if="resource" class="flex flex-col gap-4">
        <SettingsErrorAlert v-if="problem" :message="problem" />
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
            <AdminResourceForm
              :key="resource.id"
              :initial="draftOf(resource)"
              :errors="fieldErrors"
              :busy="saving"
              cancellable
              :save="saveEdit"
              @cancel="close"
            />
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
          @click="close"
        />
      </div>
    </template>
  </UModal>
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

type Body = NonNullable<ReturnType<typeof toBody>>

const props = defineProps<{
  resource: AdminResource | null
  tab: 'details' | 'access'
  /** The people a rule can name: those who signed in once. */
  users: readonly AccessUser[]
  /** The groups a rule can name (the Groups page's). */
  groups: readonly { name: string }[]
}>()
const emit = defineEmits<{
  close: []
  'update:tab': [tab: 'details' | 'access']
  /** The resource as the server saved it, and the words for it. */
  saved: [resource: AdminResource, message: string]
}>()

const api = useAuthFetch()
const status = useLiveStatus()
const saving = ref(false)
const problem = ref<string | null>(null)
const notice = ref('')
const fieldErrors = ref<Record<string, string>>({})
// The rules of the resource that is open; null until they are loaded.
const rules = ref<ResourceRule[] | null>(null)
const rulesFor = ref<number | null>(null)
const rulesError = ref<string | null>(null)

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

// Another resource: nothing of the last one is shown.
watch(
  () => props.resource?.id,
  () => {
    problem.value = null
    notice.value = ''
    fieldErrors.value = {}
    rules.value = null
    rulesFor.value = null
    rulesError.value = null
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

async function saveEdit(body: Body): Promise<boolean> {
  const target = props.resource
  if (!target) return false
  const answer: { saved?: AdminResource } = {}
  const result = await run(async () => {
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
    emit('saved', answer.saved, notice.value)
    emit('close')
  }
  return result.ok
}

async function saveRules(next: ResourceRule[], done: string): Promise<boolean> {
  const target = props.resource
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

function close() {
  // Not while a change is on its way: its answer belongs to this dialog.
  if (!saving.value) emit('close')
}
</script>
