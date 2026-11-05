<!--
  Who else sees a group calendar, in a dialog: the owning group is listed first, fixed, with what
  it may do (it cannot be removed here). Each other share can be removed; adding a person or a
  group picks one of the people who signed in once or one of the groups the page lists, with "Can
  view" or "Can edit". Saving sends the complete list. The dialog stays open while saving fails,
  so the person can see the reason and try again. Focus returns to the button that opened it.
-->
<template>
  <UModal
    :open="open"
    :title="t('Share {name}', { name: calendar?.name ?? '' })"
    :description="t('The group keeps full access. Choose who else may see this calendar.')"
    :content="{ onOpenAutoFocus: focusFirst, onCloseAutoFocus: focusReturn.restore }"
    :ui="{ title: 'wrap-anywhere', description: 'wrap-anywhere' }"
    @update:open="onOpenChange"
  >
    <template #body>
      <div v-if="calendar" class="flex flex-col gap-5" :aria-busy="busy">
        <SettingsErrorAlert v-if="alert" :message="alert" />

        <section aria-labelledby="share-current-heading" class="flex flex-col gap-2">
          <h3 id="share-current-heading" class="font-semibold">{{ t('Who has access') }}</h3>
          <ul :aria-label="t('Who has access')" class="flex flex-col gap-2">
            <li
              class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-default p-3"
            >
              <UIcon name="i-lucide-lock" class="size-5 shrink-0" aria-hidden="true" />
              <p class="min-w-0 flex-1 basis-40 font-medium wrap-anywhere">
                {{ t('Group {name}', { name: groupName }) }}
              </p>
              <p class="text-sm text-toned">
                {{
                  t('Owner, {level}, cannot be changed here', { level: permissionLabel('write') })
                }}
              </p>
            </li>
            <li
              v-for="share in rows"
              :key="`${share.principalType}:${share.principal}`"
              data-share
              class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
            >
              <UIcon
                :name="share.principalType === 'group' ? 'i-lucide-users' : 'i-lucide-user'"
                class="size-5 shrink-0"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1 basis-40">
                <p class="font-medium wrap-anywhere">{{ share.label }}</p>
                <p class="text-sm text-toned">
                  {{ principalKind(share.principalType) }} · {{ permissionLabel(share.permission) }}
                </p>
              </div>
              <UButton
                :aria-label="t('Stop sharing with {name}', { name: share.label })"
                icon="i-lucide-x"
                :label="t('Remove')"
                color="neutral"
                variant="outline"
                :disabled="busy"
                @click="remove(share)"
              />
            </li>
          </ul>
          <p v-if="rows.length === 0" class="text-sm text-toned">
            {{ t('Not shared with anybody else.') }}
          </p>
        </section>

        <form
          class="flex flex-col gap-4 rounded-lg border border-default p-4"
          novalidate
          aria-labelledby="share-add-heading"
          @submit.prevent="add"
        >
          <h3 id="share-add-heading" class="font-semibold">{{ t('Share with') }}</h3>
          <URadioGroup
            v-model="kind"
            :legend="t('Share with')"
            :items="kindItems"
            :ui="RADIO_UI"
            orientation="horizontal"
          />
          <UFormField v-if="kind === 'user'" :label="t('Person')" :error="problem" required>
            <USelectMenu
              v-model="person"
              :items="personItems"
              value-key="value"
              :search-input="SEARCH_PEOPLE"
              :placeholder="t('Choose a person')"
              class="w-full"
              :ui="{
                base: 'min-h-11',
                item: 'min-h-11 items-center',
                placeholder: 'truncate text-toned',
              }"
            >
              <template #empty>{{
                t('Nobody matches. People appear here after they signed in once.')
              }}</template>
            </USelectMenu>
          </UFormField>
          <UFormField v-else :label="t('Group')" :error="problem" required>
            <USelectMenu
              v-model="group"
              :items="groupItems"
              value-key="value"
              :search-input="SEARCH_GROUPS"
              :placeholder="t('Choose a group')"
              class="w-full"
              :ui="{
                base: 'min-h-11',
                item: 'min-h-11 items-center',
                placeholder: 'truncate text-toned',
              }"
            >
              <template #empty>{{ t('No group matches.') }}</template>
            </USelectMenu>
          </UFormField>
          <URadioGroup
            v-model="permission"
            :legend="t('Access level')"
            :items="permissionItems"
            :ui="RADIO_UI"
            orientation="vertical"
          />
          <div>
            <UButton type="submit" :label="t('Add')" icon="i-lucide-plus" :disabled="busy" />
          </div>
        </form>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          ref="cancelButton"
          :label="t('Cancel')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="onOpenChange(false)"
        />
        <UButton
          :label="busy ? t('Working…') : t('Save sharing')"
          icon="i-lucide-save"
          :aria-busy="busy"
          @click="submitShares"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { principalKind, userLabel } from '~/utils/admin/access'
import { t, tv } from '~/utils/i18n'
import {
  SHARE_PERMISSIONS,
  permissionLabel,
  type CalendarShare,
  type GroupCalendar,
  type GroupPerson,
  type GroupSummary,
  type SharePermission,
  type SharePrincipalType,
} from '~/utils/groups/model'
import { extraShares, withShare, withoutShare } from '~/utils/groups/shares'
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { createFocusReturn } from '~/utils/settings/focus-return'

const props = defineProps<{
  open: boolean
  calendar: GroupCalendar | null
  groupName: string
  groups: readonly GroupSummary[]
  people: readonly GroupPerson[]
  busy: boolean
  /** Saves the complete list of extra shares; true when it worked, else the words for the failure. */
  save: (shares: CalendarShare[]) => Promise<true | string>
}>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

// 44 px rows for the radio buttons (design §9).
const RADIO_UI = { item: 'min-h-11 items-center' }
const SEARCH_PEOPLE = computed(() => ({
  placeholder: t('Search people'),
  'aria-label': t('Search people'),
}))
const SEARCH_GROUPS = computed(() => ({
  placeholder: t('Search groups'),
  'aria-label': t('Search groups'),
}))

const focusReturn = createFocusReturn(() => null)
const cancelButton = useTemplateRef<{ $el: HTMLElement }>('cancelButton')

const kind = ref<SharePrincipalType>('user')
const person = ref<string | undefined>(undefined)
const group = ref<string | undefined>(undefined)
const permission = ref<SharePermission>('read')
const problem = ref<string | undefined>(undefined)
const alert = ref<string | undefined>(undefined)
const draft = ref<CalendarShare[]>([])

const kindItems = computed(() => [
  { value: 'user', label: t('A person') },
  { value: 'group', label: t('A group') },
])
const permissionItems = computed(() =>
  SHARE_PERMISSIONS.map((level) => ({
    value: level.value as string,
    label: tv(level.label),
    description: tv(level.help),
  })),
)
const personItems = computed(() =>
  props.people.map((item) => ({ value: item.sub, label: userLabel(item) })),
)
const groupItems = computed(() =>
  props.groups
    .filter((item) => item.name !== props.groupName)
    .map((item) => ({ value: item.name, label: item.name })),
)

const rows = computed(() => draft.value)

// Each time the dialog opens, the draft starts from what the calendar has now.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    focusReturn.remember()
    draft.value = props.calendar ? extraShares(props.calendar, props.groupName) : []
    problem.value = undefined
    alert.value = undefined
    person.value = undefined
    group.value = undefined
    permission.value = 'read'
  },
)

function onOpenChange(open: boolean) {
  // A save in flight cannot be taken back: stay open until it has answered.
  if (!open && props.busy) return
  emit('update:open', open)
}

function focusFirst(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  const button = cancelButton.value?.$el
  if (!button) return
  event.preventDefault()
  button.focus()
}

function add() {
  problem.value = undefined
  if (kind.value === 'user') {
    const chosen = props.people.find((item) => item.sub === person.value)
    if (!chosen) {
      problem.value = t('Choose a person.')
      return
    }
    draft.value = withShare(draft.value, {
      principalType: 'user',
      principal: chosen.sub,
      label: userLabel(chosen),
      permission: permission.value,
    })
    person.value = undefined
    return
  }
  const chosen = props.groups.find((item) => item.name === group.value)
  if (!chosen) {
    problem.value = t('Choose a group.')
    return
  }
  draft.value = withShare(draft.value, {
    principalType: 'group',
    principal: chosen.name,
    label: chosen.name,
    permission: permission.value,
  })
  group.value = undefined
}

function remove(share: CalendarShare) {
  draft.value = withoutShare(draft.value, share.principalType, share.principal)
}

async function submitShares() {
  if (props.busy) return
  alert.value = undefined
  const answer = await props.save([...draft.value])
  if (answer === true) emit('update:open', false)
  else alert.value = answer
}
</script>
