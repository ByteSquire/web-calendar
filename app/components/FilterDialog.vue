<!--
  Adds a filter or changes one (FR-5): its name, what it looks at (a text, a category, a status or
  people), what it looks for, and whether it shows only the matching events or hides them. People
  are chosen from a list of those the loaded events and calendars name, as many as wanted, or typed
  (a name or an address); they show as tags. A sentence under the fields says what the filter will
  do. Until the person types a name of their
  own, the name follows what the filter looks for ("Work", "Hide: Cancelled").

  It reports the filter (`save`); the caller saves it and closes the dialog, or sets `error` to
  keep it open with the reason. A filter with a problem (utils/filters.ts) is not reported.

  Focus: into the name when it opens (not on a touch screen); back to `returnFocusTo` when it
  closes, which the plus of the section passes, as Reka UI only returns it to a trigger it knows.
-->
<template>
  <UModal
    :open="open"
    :title="title"
    :description="
      t('Filters narrow down the events shown. Switch a filter on in the list to use it.')
    "
    :ui="{ title: 'wrap-anywhere', wrapper: 'pe-10' }"
    :content="{ onOpenAutoFocus: focusName, onCloseAutoFocus: restoreFocus }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <form
        :id="formId"
        v-bind="NOT_FOR_PASSWORD_MANAGERS"
        novalidate
        class="flex flex-col gap-4"
        :aria-busy="pending"
        @submit.prevent="onSubmit"
      >
        <FormAlert :message="error" />
        <UFormField
          :label="t('Name')"
          :help="
            nameEdited ? undefined : t('Follows what the filter looks for until you change it.')
          "
          :error="problems.name"
          required
        >
          <UInput
            ref="nameInput"
            :model-value="name"
            :maxlength="FILTER_NAME_MAX"
            required
            autocomplete="off"
            v-bind="NOT_FOR_PASSWORD_MANAGERS"
            class="w-full"
            @update:model-value="onNameInput(String($event ?? ''))"
          />
        </UFormField>

        <URadioGroup
          v-model="kind"
          :legend="t('Filter by')"
          :items="kindItems"
          orientation="horizontal"
          :ui="RADIO_UI"
        />

        <UFormField
          v-if="kind === 'text'"
          :label="t('Text to look for')"
          :help="t('Looks in the title, the place and the notes, without regard to case.')"
          :error="problems.value"
          required
        >
          <UInput
            v-model="values.text"
            :maxlength="FILTER_VALUE_MAX"
            autocomplete="off"
            v-bind="NOT_FOR_PASSWORD_MANAGERS"
            class="w-full"
          />
        </UFormField>

        <template v-else-if="kind === 'category'">
          <UFormField
            v-if="categoryItems.length > 0"
            :label="t('Category')"
            :error="problems.value"
            required
          >
            <USelect
              v-model="values.category"
              :items="categoryItems"
              :placeholder="t('Choose a category')"
              class="w-full"
              :ui="SELECT_UI"
            />
          </UFormField>
          <template v-else>
            <p class="text-sm text-toned">
              {{ t('There are no categories yet. Add one in the categories of the sidebar.') }}
            </p>
            <p v-if="problems.value" class="text-sm text-error">{{ problems.value }}</p>
          </template>
        </template>

        <template v-else-if="kind === 'status'">
          <URadioGroup
            v-model="values.status"
            :legend="t('Status')"
            :items="statusItems"
            orientation="horizontal"
            :ui="RADIO_UI"
          />
          <p v-if="problems.value" class="text-sm text-error">{{ problems.value }}</p>
        </template>

        <UFormField
          v-else
          :label="t('People')"
          :help="
            t(
              'Matches who organised or made the event; for an event that names nobody, the owner of its calendar.',
            )
          "
          :error="problems.value"
          required
        >
          <UInputMenu
            ref="peopleMenu"
            v-model="people"
            v-model:search-term="peopleSearch"
            multiple
            value-key="value"
            :items="peopleItems"
            :filter-fields="['label', 'description']"
            create-item
            open-on-click
            :placeholder="t('Choose people, or type a name or an e-mail address')"
            :maxlength="FILTER_VALUE_MAX"
            autocomplete="off"
            v-bind="NOT_FOR_PASSWORD_MANAGERS"
            class="w-full"
            :ui="PEOPLE_UI"
            @create="addPerson"
          >
            <template #tags-item-text="{ item }">{{ tagText(item) }}</template>
          </UInputMenu>
        </UFormField>

        <URadioGroup
          v-model="mode"
          :legend="t('Matching events')"
          :items="modeItems"
          :ui="RADIO_UI"
        />

        <p v-if="summary" class="text-sm text-toned" aria-live="polite">{{ summary }}</p>
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
import { STATUS_LABELS } from '~/utils/event-display'
import {
  EVENT_STATUSES,
  FILTER_KINDS,
  FILTER_MODES,
  FILTER_NAME_MAX,
  FILTER_PEOPLE_MAX,
  FILTER_VALUE_MAX,
  checkFilterDraft,
  describeFilter,
  filterPeople,
  isEmptyFilterValue,
  peopleValue,
  personLabel,
  splitPerson,
  suggestedFilterName,
  type FilterDraft,
  type FilterProblems,
  type KnownPerson,
} from '~/utils/filters'
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { NOT_FOR_PASSWORD_MANAGERS } from '~/utils/password-managers'
import { t, tv } from '~/utils/i18n'
import type {
  CalendarFilter,
  Category,
  EventStatus,
  FilterKind,
  FilterMode,
} from '../../shared/types/calendar'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** The filter to change; null adds one. */
    filter?: CalendarFilter | null
    /** The person's filters, for the names that are taken. */
    filters?: readonly CalendarFilter[]
    /** The categories a category filter can name. */
    categories?: readonly Pick<Category, 'id' | 'name'>[]
    /** The people the list of a person filter offers (any other one may be typed). */
    knownPeople?: readonly KnownPerson[]
    pending?: boolean
    /** Why the last save failed; shown at the top of the form. */
    error?: string
    returnFocusTo?: HTMLElement | null
  }>(),
  {
    filter: null,
    filters: () => [],
    categories: () => [],
    knownPeople: () => [],
    pending: false,
    error: '',
    returnFocusTo: null,
  },
)
const emit = defineEmits<{ 'update:open': [open: boolean]; save: [draft: FilterDraft] }>()
useBackDismiss(toRef(props, 'open'), () => emit('update:open', false))

const RADIO_UI = { fieldset: 'flex-wrap gap-x-4 gap-y-1', item: 'min-h-11 items-center' }
const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }
// The cross of a tag is small; its pseudo-element grows the target, as the sidebar's switches do.
// The field is `type="search"`: Bitwarden, which by default leaves `data-bwignore` aside, never
// offers to fill a search field, and took this one for a login. The browser's own clear button of
// a search field is hidden; the tags have their crosses.
const PEOPLE_UI = {
  base: 'min-h-11',
  item: 'min-h-11 items-center',
  tagsItem: 'min-h-8',
  tagsItemDelete: 'relative before:absolute before:-inset-2',
  tagsInput: '[&::-webkit-search-cancel-button]:appearance-none',
}

const formId = `filter-${useId()}`
const nameInput = useTemplateRef<{ inputRef?: HTMLInputElement }>('nameInput')

const name = ref('')
/** The person typed a name of their own; until then it follows `suggestedFilterName`. */
const nameEdited = ref(false)
const kind = ref<FilterKind>('text')
const mode = ref<FilterMode>('only')
// One value per kind, so going to another kind and back keeps what was entered; the people of a
// person filter are a list.
const values = reactive<{ text: string; category: string; status: EventStatus | undefined }>({
  text: '',
  category: '',
  status: 'cancelled',
})
const people = ref<string[]>([])
/** People typed in this dialog, offered in the list too, so that their tags show. */
const typedPeople = ref<string[]>([])
/** What is typed into the list of people. */
const peopleSearch = ref('')

// The field of the people is a search field (see PEOPLE_UI). With `multiple`, Nuxt UI 4.12 does not
// pass its `type` on, and Reka UI writes `type="text"`; the element gets the type itself, which no
// later render resets (Reka's "text" never changes, so Vue never writes it again).
const peopleMenu = useTemplateRef<{ inputRef?: HTMLInputElement | null }>('peopleMenu')
watch(
  () => peopleMenu.value?.inputRef,
  (input) => {
    if (input && input.type !== 'search') input.type = 'search'
  },
  { flush: 'post' },
)
const submitted = ref(false)

const kindItems = computed(() =>
  FILTER_KINDS.map((item) => ({ value: item.value, label: tv(item.label) })),
)
const modeItems = computed(() =>
  FILTER_MODES.map((item) => ({ value: item.value, label: tv(item.label) })),
)
const statusItems = computed(() =>
  EVENT_STATUSES.map((status) => ({ value: status, label: tv(STATUS_LABELS[status]) })),
)
/** The categories by name, each once; a name the filter holds stays offered even if it is gone. */
const categoryItems = computed(() => {
  const names = new Map<string, string>()
  for (const category of props.categories) {
    const key = category.name.toLowerCase()
    if (!names.has(key)) names.set(key, category.name)
  }
  const held = values.category.trim()
  if (held && !names.has(held.toLowerCase())) names.set(held.toLowerCase(), held)
  return [...names.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((item) => ({ value: item, label: item }))
})

/**
 * The list of a person filter: the known people, then the ones the filter holds or that were typed
 * and are not among them; each with its address under the name.
 */
const peopleItems = computed(() => {
  const known = new Set(props.knownPeople.map((person) => person.value.toLowerCase()))
  const others = [...people.value, ...typedPeople.value]
    .filter((entry) => !known.has(entry.toLowerCase()))
    .filter((entry, index, list) => list.indexOf(entry) === index)
    .map((entry) => ({ label: personLabel(entry), email: splitPerson(entry).email, value: entry }))
  return [...props.knownPeople, ...others].map((person) => ({
    label: person.label,
    value: person.value,
    ...(person.email && person.email !== person.label ? { description: person.email } : {}),
  }))
})

const value = computed(() =>
  kind.value === 'person' ? peopleValue(people.value) : (values[kind.value] ?? ''),
)
const draft = computed<FilterDraft>(() => ({
  name: name.value,
  kind: kind.value,
  value: value.value,
  mode: mode.value,
}))
const problems = computed<FilterProblems>(() =>
  submitted.value ? checkFilterDraft(draft.value, props.filters, props.filter?.id) : {},
)
const summary = computed(() => (isEmptyFilterValue(draft.value) ? '' : describeFilter(draft.value)))

const title = computed(() =>
  props.filter ? t('Edit filter {name}', { name: props.filter.name }) : t('Add filter'),
)
const submitLabel = computed(() => (props.filter ? t('Save') : t('Add filter')))

// The name follows what the filter looks for until the person types one.
watch([kind, mode, value], () => {
  if (!nameEdited.value) name.value = suggestedFilterName(draft.value)
})

/** A category filter made before names were stored holds the category's id: shown as its name. */
function categoryValue(value: string): string {
  return props.categories.find((category) => category.id === value)?.name ?? value
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const filter = props.filter
    values.text = ''
    values.category = ''
    values.status = 'cancelled'
    people.value = []
    typedPeople.value = []
    submitted.value = false
    if (!filter) {
      kind.value = 'text'
      mode.value = 'only'
      name.value = ''
      nameEdited.value = false
      return
    }
    kind.value = filter.kind
    mode.value = filter.mode
    if (filter.kind === 'person') people.value = filterPeople(filter.value)
    else if (filter.kind === 'status') {
      // A status the app does not know (an old row) leaves the choice empty: saving then asks for one.
      values.status = EVENT_STATUSES.find((item) => item === filter.value)
    } else {
      values[filter.kind] = filter.kind === 'category' ? categoryValue(filter.value) : filter.value
    }
    name.value = filter.name
    nameEdited.value = filter.name !== suggestedFilterName(draft.value)
  },
  { immediate: true },
)

/** A name or an address typed into the list of people becomes one of them. */
function addPerson(text: string) {
  peopleSearch.value = ''
  const entry = text.trim()
  if (!entry || people.value.length >= FILTER_PEOPLE_MAX) return
  const key = entry.toLowerCase()
  if (!people.value.some((item) => item.toLowerCase() === key))
    people.value = [...people.value, entry]
  if (!typedPeople.value.some((item) => item.toLowerCase() === key)) {
    typedPeople.value = [...typedPeople.value, entry]
  }
}

/** A tag shows the person's name (or address), not the address after it. */
function tagText(item: unknown): string {
  if (typeof item === 'string') return personLabel(item)
  const value = (item as { value?: unknown } | null)?.value
  return typeof value === 'string' ? personLabel(value) : ''
}

function onNameInput(text: string) {
  name.value = text
  // Emptied, it follows what the filter looks for again.
  nameEdited.value = text.trim() !== ''
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
  const found = checkFilterDraft(draft.value, props.filters, props.filter?.id)
  if (found.name || found.value) {
    await nextTick()
    if (found.name) nameInput.value?.inputRef?.focus()
    return
  }
  emit('save', { ...draft.value, name: draft.value.name.trim(), value: draft.value.value.trim() })
}
</script>
