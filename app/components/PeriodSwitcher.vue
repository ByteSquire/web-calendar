<!--
  The period buttons of the split and the list view: one toggle button per span, the chosen one
  pressed. The top bar's prev/today/next then step by that span. "Custom range" starts as the
  period shown and adds two date fields beside the buttons; "Show" (or Enter) shows the dates
  entered, both days included (`checkCustomRange`), of any length; past `LONG_RANGE_DAYS` a toast
  warns that it is long. Prev/next then move the range
  by its own length. Not printed (main.css): the heading on paper names the dates.
-->
<template>
  <div class="period-switcher print-hidden flex flex-wrap items-end gap-x-4 gap-y-2 px-3 py-2">
    <div class="flex flex-wrap items-center gap-2" role="group" :aria-label="t('Period')">
      <UButton
        v-for="span in spans"
        :key="span"
        :label="tv(SPAN_LABELS[span])"
        :color="span === model ? 'primary' : 'neutral'"
        :variant="span === model ? 'solid' : 'outline'"
        :aria-pressed="span === model"
        @click="choose(span)"
      />
    </div>
    <!-- Controls of the view itself, such as the split view's layout. -->
    <slot />
    <form
      v-if="model === 'custom'"
      class="flex flex-wrap items-start gap-2"
      :aria-label="t('Custom range')"
      novalidate
      @submit.prevent="show"
    >
      <UFormField :label="t('From')" name="range-from" required :error="errors.from">
        <UInput ref="fromInput" v-model="from" type="date" required />
      </UFormField>
      <UFormField :label="t('To')" name="range-to" required :error="errors.to">
        <UInput ref="toInput" v-model="to" type="date" required />
      </UFormField>
      <!-- Lined up with the fields, below their labels. -->
      <UButton type="submit" :label="t('Show')" color="neutral" variant="outline" class="mt-6" />
    </form>
  </div>
</template>

<script setup lang="ts" generic="Span extends keyof typeof SPAN_LABELS">
import { LONG_RANGE_DAYS, SPAN_LABELS, checkCustomRange } from '~/utils/calendar-state'
import { t, tv } from '~/utils/i18n'

defineProps<{ spans: readonly Span[] }>()
const model = defineModel<Span>({ required: true })

const { visibleRange, chooseCustomRange, setCustomRange } = useCalendarState()
const toast = useToast()

function choose(span: Span) {
  // The custom range starts as the period shown, and the state sets the span itself.
  if (span === 'custom') chooseCustomRange()
  else model.value = span
}

// The fields show the range in use until the person changes them; prev/next and today move it.
const from = ref('')
const to = ref('')
const errors = reactive<{ from?: string; to?: string }>({})

watch(
  visibleRange,
  ({ start, end }) => {
    from.value = start.toString()
    to.value = end.subtract({ days: 1 }).toString()
    errors.from = undefined
    errors.to = undefined
  },
  { immediate: true },
)

type InputRef = { inputRef: HTMLInputElement | null } | null
const fromInput = useTemplateRef<InputRef>('fromInput')
const toInput = useTemplateRef<InputRef>('toInput')

async function show() {
  const result = checkCustomRange(from.value, to.value)
  errors.from = undefined
  errors.to = undefined
  if (result.ok) {
    setCustomRange(result.first, result.last)
    // Shown all the same; the person learns why it is slow and long (LONG_RANGE_DAYS).
    if (result.days > LONG_RANGE_DAYS) {
      toast.add({
        title: t('Long range'),
        description: t(
          '{count} days can take a while to load, and make the view and its printout very long.',
          { count: result.days },
        ),
        icon: 'i-lucide-triangle-alert',
        color: 'warning',
      })
    }
    return
  }
  errors[result.field] = result.message
  await nextTick()
  ;(result.field === 'from' ? fromInput : toInput).value?.inputRef?.focus()
}
</script>
