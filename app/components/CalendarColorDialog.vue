<!--
  The colour of one calendar in the sidebar, for the viewer alone (`/api/calendar-prefs`, FR-4):
  a named colour, any colour ("Custom"), or "Default", the calendar's own (the colour its source
  gives it, else the palette's). Saved with Save; a refusal keeps the dialog open with the reason,
  and the calendar keeps its colour. Opened from "Colour" in the menu of the calendar's row.
-->
<template>
  <ColorDialog
    :open="calendar !== null"
    :title="t('Colour of {name}', { name: shownName })"
    :description="t('Only you see this colour, on all your devices.')"
    :choices="choices"
    :value="initial"
    :pending="saving"
    :error="problem"
    @close="emit('close')"
    @save="save"
  />
</template>

<script setup lang="ts">
import type { Calendar } from '../../shared/types/calendar'
import { N_, t } from '~/utils/i18n'
import { describeError } from '~/utils/settings/api-errors'
import { COLOR_PALETTE, type ColorChoice } from '~/utils/settings/palette'

const props = defineProps<{ calendar: Calendar | null }>()
const emit = defineEmits<{ close: [] }>()

const { setCalendarColor } = useCalendarState()
const saving = ref(false)
const problem = ref<string | null>(null)
// Kept while the dialog closes, so the title does not flash empty.
const shownName = ref('')
const initial = ref('')

const choices = computed<ColorChoice[]>(() => [
  { value: '', name: N_('Default'), swatch: props.calendar?.ownColor ?? props.calendar?.color },
  ...COLOR_PALETTE,
])

watch(
  () => props.calendar,
  (calendar) => {
    if (!calendar) return
    shownName.value = calendar.name
    problem.value = null
    // The viewer's own choice, or "Default" while the calendar shows its own colour.
    const own = calendar.ownColor ?? calendar.color
    initial.value =
      calendar.color.toLowerCase() === own.toLowerCase() ? '' : calendar.color.toLowerCase()
  },
  { immediate: true },
)

async function save(color: string) {
  const calendar = props.calendar
  if (!calendar || saving.value) return
  saving.value = true
  problem.value = null
  try {
    await setCalendarColor(calendar.id, color === '' ? null : color)
    saving.value = false
    emit('close')
  } catch (cause) {
    problem.value = describeError(cause, N_('save the colour'))
    saving.value = false
  }
}
</script>
