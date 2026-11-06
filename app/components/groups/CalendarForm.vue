<!--
  The name and colour of a calendar (a group's, or any on Admin › Calendars): a new one, or the
  rename and recolour of an existing one. The name is checked here the way the server checks it (1..100 characters after trimming, no
  control characters). The colour is one of the palette's named colours (settings/ColorPicker), so
  the choice is not colour-only information. The parent's save returns true, or the server's words.
-->
<template>
  <form
    class="flex flex-col gap-4"
    novalidate
    :aria-labelledby="headingId"
    :aria-busy="busy"
    @submit.prevent="submit"
  >
    <h4 :id="headingId" class="font-medium">{{ heading }}</h4>
    <SettingsErrorAlert v-if="alert" :message="alert" />

    <UFormField :label="t('Name')" :error="problem" required>
      <UInput v-model="name" autocomplete="off" maxlength="100" class="w-full max-w-md" />
    </UFormField>

    <SettingsColorPicker v-model="color" :choices="choices" />

    <div class="flex flex-wrap gap-2">
      <UButton type="submit" :label="submitLabel" :icon="submitIcon" :loading="busy" />
      <UButton
        v-if="cancellable"
        type="button"
        :label="t('Cancel')"
        color="neutral"
        variant="outline"
        :disabled="busy"
        @click="emit('cancel')"
      />
    </div>
  </form>
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'
import { colorChoices, initialColor } from '~/utils/settings/palette'
import { calendarNameProblem, isColor } from '~/utils/groups/model'
import type { GroupCalendar } from '~/utils/groups/model'

export interface CalendarFormBody {
  name: string
  color: string | null
}

const props = defineProps<{
  /** The calendar being changed; without it the form adds one. */
  initial?: Pick<GroupCalendar, 'name' | 'color'>
  busy: boolean
  cancellable?: boolean
  /** Saves; true when it worked, else the words for the failure. */
  save: (body: CalendarFormBody) => Promise<true | string>
}>()
const emit = defineEmits<{ cancel: [] }>()

const editing = computed(() => props.initial !== undefined)
const headingId = `calendar-form-${useId()}`
const heading = computed(() => (editing.value ? t('Edit calendar') : t('New calendar')))
const submitLabel = computed(() => (editing.value ? t('Save changes') : t('Add calendar')))
const submitIcon = computed(() => (editing.value ? 'i-lucide-save' : 'i-lucide-plus'))

const name = ref(props.initial?.name ?? '')
const color = ref(initialColor(props.initial?.color, editing.value))
const choices = computed(() => colorChoices(props.initial?.color, editing.value))
const problem = ref<string | undefined>(undefined)
const alert = ref<string | undefined>(undefined)

async function submit() {
  alert.value = undefined
  problem.value = calendarNameProblem(name.value) ?? undefined
  if (problem.value) return
  if (!isColor(color.value)) {
    alert.value = t('Choose a colour from the list.')
    return
  }
  const body: CalendarFormBody = { name: name.value.trim(), color: color.value || null }
  const answer = await props.save(body)
  if (answer === true) {
    if (!editing.value) {
      name.value = ''
      color.value = initialColor(undefined, false)
    }
  } else {
    alert.value = answer
  }
}
</script>
