<!--
  Split view (FR-6): every visible calendar with events in the period gets its own band, as one
  row of a FullCalendar resource timeline (SplitTimeline). Empty calendars are already left out
  by `splitBands`. The date, the period and the bands come from the shared calendar state; the
  top bar's prev/today/next move the timeline, and the span switcher below sets `splitSpan`.
  The main area scrolls, not this component.
-->
<template>
  <section class="flex min-h-full flex-col" :aria-label="`Split view, ${rangeLabel}`">
    <div class="flex flex-wrap items-center gap-2 px-3 py-2" role="group" aria-label="Period">
      <UButton
        v-for="span in SPLIT_SPANS"
        :key="span"
        :label="VIEW_TYPE_LABELS[span]"
        :color="span === splitSpan ? 'primary' : 'neutral'"
        :variant="span === splitSpan ? 'solid' : 'outline'"
        :aria-pressed="span === splitSpan"
        @click="splitSpan = span"
      />
    </div>

    <SplitTimeline
      v-if="splitBands.length > 0"
      :bands="splitBands"
      :date="anchorDate.toString()"
      :span="splitSpan"
      :scheme="scheme"
      :time-zone="timeZone"
      @select="selectEvent"
      @create="openQuickAdd"
    />
    <div
      v-else
      role="status"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <UIcon name="i-lucide-calendar-x" class="size-8 text-muted" aria-hidden="true" />
      <p class="text-highlighted">No events for the selected calendars in this period</p>
      <p class="text-sm text-muted">
        Select more calendars in the sidebar, change the filters or move to another date.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { SPLIT_SPANS, VIEW_TYPE_LABELS } from '~/utils/calendar-state'
import { splitColorScheme } from '~/utils/split-view'

const { anchorDate, openQuickAdd, rangeLabel, selectEvent, splitBands, splitSpan } =
  useCalendarState()
const timeZone = useDisplayTimeZone()
const colorMode = useColorMode()
const scheme = computed(() => splitColorScheme(colorMode.value))
</script>
