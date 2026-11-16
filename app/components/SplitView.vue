<!--
  Split view (FR-6): every visible calendar with events in the period gets its own band, as one
  row of a FullCalendar resource timeline (SplitTimeline). Empty calendars are already left out
  by `splitBands`. The date, the period and the bands come from the shared calendar state; the
  top bar's prev/today/next move the timeline, and the span switcher below sets `splitSpan`.
  "Swap rows and columns" beside the period buttons shows the calendars as columns with a row
  per day instead (SplitColumns, `splitOrientation`); the screen and the paper show the same.
  The main area scrolls, not this component.
-->
<template>
  <section
    class="split-view flex flex-col"
    :class="columns ? 'h-full' : 'min-h-full'"
    :aria-label="t('Split view, {range}', { range: rangeLabel })"
  >
    <PeriodSwitcher v-model="splitSpan" :spans="SPLIT_SPANS">
      <!-- Below 1024 px only the icon shows, so the buttons keep to one row on a phone held sideways. -->
      <UButton
        icon="i-lucide-arrow-right-left"
        :color="columns ? 'primary' : 'neutral'"
        :variant="columns ? 'solid' : 'outline'"
        :aria-pressed="columns"
        :aria-label="t('Swap rows and columns')"
        :title="t('Swap rows and columns')"
        @click="splitOrientation = columns ? 'rows' : 'columns'"
      >
        <span class="hidden lg:inline">{{ t('Swap rows and columns') }}</span>
      </UButton>
    </PeriodSwitcher>

    <SplitColumns
      v-if="splitBands.length > 0 && columns"
      class="flex-1"
      :bands="splitBands"
      :range="visibleRange"
      :scheme="scheme"
      :today="today"
      :category-by-id="categoryColorsShown ? categoryById : undefined"
      @select="selectEvent"
      @create="openQuickAdd"
    />
    <SplitTimeline
      v-else-if="splitBands.length > 0"
      :bands="splitBands"
      :date="anchorDate.toString()"
      :span="splitSpan"
      :custom-days="customDays"
      :scheme="scheme"
      :time-zone="timeZone"
      :category-by-id="categoryColorsShown ? categoryById : undefined"
      @select="selectEvent"
      @create="openQuickAdd"
    />
    <div
      v-else
      role="status"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <UIcon name="i-lucide-calendar-x" class="size-8 text-muted" aria-hidden="true" />
      <p class="text-highlighted">
        {{ t('No events for the selected calendars in this period') }}
      </p>
      <p class="text-sm text-muted">
        {{ t('Select more calendars in the sidebar, change the filters or move to another date.') }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Temporal } from 'temporal-polyfill'
import { SPLIT_SPANS } from '~/utils/calendar-state'
import { t } from '~/utils/i18n'
import { splitColorScheme } from '~/utils/split-view'

const {
  anchorDate,
  categoryById,
  customDays,
  openQuickAdd,
  rangeLabel,
  selectEvent,
  splitBands,
  splitOrientation,
  splitSpan,
  visibleRange,
} = useCalendarState()
// Calendars as columns and days as rows (SplitColumns), or the timeline with a row per calendar.
const columns = computed(() => splitOrientation.value === 'columns')
// "Category colours on events" (the ⋮ menu): the timeline draws a dot per category, as CalendarMain.
const { shown: categoryColorsShown } = useCategoryColorsOnEvents()
const timeZone = useDisplayTimeZone()
const today = computed(() => Temporal.Now.plainDateISO(timeZone.value))
const colorMode = useColorMode()
const scheme = computed(() => splitColorScheme(colorMode.value))
</script>
