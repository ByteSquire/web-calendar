<!--
  Adds a view or changes one (FR-2, FR-21): its name and the calendars it groups. Selecting the view
  later shows exactly those calendars. It reports the name and the chosen calendars (`save`); the
  caller saves them and closes the dialog, or sets `error` to keep it open with the reason. A view
  without a name, with a name that is taken or without a calendar is not reported.

  `calendars` are the calendars the view can hold (utils/view-form.ts): a view names no resource, a
  shared one no external calendar. Calendars of the view that are not among them (the viewer cannot
  see them) are counted in `hiddenCount` and kept by the caller.

  Focus: into the name when it opens (not on a touch screen); back to `returnFocusTo` when it
  closes, which the plus of the section passes, as Reka UI only returns it to a trigger it knows.
-->
<template>
  <UModal
    :open="open"
    :title="title"
    :description="description"
    :ui="{ title: 'wrap-anywhere', wrapper: 'pe-10' }"
    :content="{ onOpenAutoFocus: focusName, onCloseAutoFocus: restoreFocus }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <form
        :id="formId"
        novalidate
        class="flex flex-col gap-4"
        :aria-busy="pending"
        @submit.prevent="onSubmit"
      >
        <FormAlert :message="error" />
        <UFormField :label="t('Name')" :error="problems.name" required>
          <UInput
            ref="nameInput"
            v-model="name"
            :maxlength="VIEW_NAME_MAX"
            required
            autocomplete="off"
            class="w-full"
          />
        </UFormField>

        <fieldset
          class="flex flex-col gap-1"
          :aria-describedby="problems.calendars ? calendarsErrorId : undefined"
        >
          <legend class="text-sm font-medium">{{ t('Calendars') }}</legend>
          <div class="flex flex-wrap gap-1">
            <UButton
              :label="t('Choose all')"
              color="neutral"
              variant="ghost"
              size="sm"
              class="min-h-11"
              :disabled="calendars.length === 0"
              @click="chosen = calendars.map((calendar) => calendar.id)"
            />
            <UButton
              :label="t('Choose none')"
              color="neutral"
              variant="ghost"
              size="sm"
              class="min-h-11"
              :disabled="chosen.length === 0"
              @click="chosen = []"
            />
          </div>
          <p v-if="calendars.length === 0" class="text-sm text-toned">
            {{ t('There are no calendars to choose from.') }}
          </p>
          <ul v-else class="flex flex-col">
            <li v-for="calendar in calendars" :key="calendar.id">
              <UCheckbox
                :model-value="chosen.includes(calendar.id)"
                :ui="CHECKBOX_UI"
                @update:model-value="toggle(calendar.id, $event === true)"
              >
                <template #label>
                  <span class="flex min-w-0 items-center gap-2">
                    <span
                      class="size-3 shrink-0 rounded-full"
                      :style="{ backgroundColor: calendar.color }"
                      aria-hidden="true"
                    />
                    <span class="wrap-anywhere">{{ calendar.name }}</span>
                  </span>
                </template>
              </UCheckbox>
            </li>
          </ul>
          <p :id="calendarsErrorId" class="text-sm text-error" aria-live="polite">
            {{ problems.calendars }}
          </p>
          <p v-if="hiddenCount > 0" class="text-sm text-toned">
            {{
              tc(
                'One more calendar of this view is not listed, as you cannot see it here; it stays in the view. | {count} more calendars of this view are not listed, as you cannot see them here; they stay in the view.',
                hiddenCount,
              )
            }}
          </p>
        </fieldset>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('Cancel')"
          color="neutral"
          variant="outline"
          @click="emit('update:open', false)"
        />
        <UButton type="submit" :form="formId" :label="submitLabel" :loading="pending" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { t, tc } from '~/utils/i18n'
import { VIEW_NAME_MAX } from '~/utils/live/user-views'
import { checkViewDraft, type ViewProblems } from '~/utils/view-form'
import type { Calendar } from '../../shared/types/calendar'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** Adding a new view, or changing one. */
    mode: 'add' | 'edit'
    /** The view is shared with everybody (only administrators change it). */
    shared?: boolean
    /** The name and the chosen calendars when the dialog opens. */
    initialName?: string
    initialIds?: readonly string[]
    /** The calendars the view can hold, in the order to show them. */
    calendars: readonly Pick<Calendar, 'id' | 'name' | 'color'>[]
    /** Calendars of the view that are not in `calendars`; they stay in it. */
    hiddenCount?: number
    /** Names of other views of the same kind. */
    takenNames?: readonly string[]
    pending?: boolean
    /** Why the last save failed; shown at the top of the form. */
    error?: string
    returnFocusTo?: HTMLElement | null
  }>(),
  {
    shared: false,
    initialName: '',
    initialIds: () => [],
    hiddenCount: 0,
    takenNames: () => [],
    pending: false,
    error: '',
    returnFocusTo: null,
  },
)
const emit = defineEmits<{
  'update:open': [open: boolean]
  save: [view: { name: string; calendarIds: string[] }]
}>()
useBackDismiss(toRef(props, 'open'), () => emit('update:open', false))

// A row is a 44 px target in full: the checkbox's pseudo-element spreads over the whole row.
const CHECKBOX_UI = {
  root: 'relative min-h-11 items-center',
  base: 'before:absolute before:inset-0',
  wrapper: 'min-w-0',
}

const formId = `view-${useId()}`
const calendarsErrorId = `view-calendars-${useId()}`
const nameInput = useTemplateRef<{ inputRef?: HTMLInputElement }>('nameInput')
const name = ref('')
const chosen = ref<string[]>([])
const submitted = ref(false)

const title = computed(() => {
  if (props.mode === 'add') return t('Add view')
  return props.shared
    ? t('Edit shared view {name}', { name: props.initialName })
    : t('Edit view {name}', { name: props.initialName })
})
const description = computed(() =>
  props.shared
    ? t('Everybody sees this view. Selecting it shows the calendars chosen here.')
    : t('Only you see this view. Selecting it shows the calendars chosen here.'),
)
const submitLabel = computed(() => (props.mode === 'add' ? t('Add view') : t('Save')))

const problems = computed<ViewProblems>(() =>
  submitted.value ? checkViewDraft(name.value, chosen.value.length, props.takenNames) : {},
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = props.initialName
    const offered = new Set(props.calendars.map((calendar) => calendar.id))
    chosen.value = props.initialIds.filter((id) => offered.has(id))
    submitted.value = false
  },
  { immediate: true },
)

function toggle(id: string, on: boolean) {
  const rest = chosen.value.filter((item) => item !== id)
  chosen.value = on ? [...rest, id] : rest
}

function focusName(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  const input = nameInput.value?.inputRef
  if (!input) return
  event.preventDefault()
  input.focus()
}

function restoreFocus(event: Event) {
  if (!props.returnFocusTo?.isConnected) return
  event.preventDefault()
  props.returnFocusTo.focus()
}

async function onSubmit() {
  if (props.pending) return
  submitted.value = true
  const found = checkViewDraft(name.value, chosen.value.length, props.takenNames)
  if (found.name || found.calendars) {
    await nextTick()
    if (found.name) nameInput.value?.inputRef?.focus()
    return
  }
  // In the order the calendars are listed, which is the sidebar's.
  const picked = new Set(chosen.value)
  emit('save', {
    name: name.value.trim(),
    calendarIds: props.calendars.map((calendar) => calendar.id).filter((id) => picked.has(id)),
  })
}
</script>
