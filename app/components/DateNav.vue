<!--
  Date navigation (FR-23): previous / today / next and the title of the shown period. The title is
  a polite live region, so a screen reader announces the new period after each step.
-->
<template>
  <div role="group" aria-label="Date navigation" class="flex items-center gap-1">
    <UButton
      icon="i-lucide-chevron-left"
      color="neutral"
      variant="ghost"
      :aria-label="dateStepLabel('previous', rangeKind)"
      @click="prev"
    />
    <UButton label="Today" color="neutral" variant="outline" @click="today" />
    <UButton
      icon="i-lucide-chevron-right"
      color="neutral"
      variant="ghost"
      :aria-label="dateStepLabel('next', rangeKind)"
      @click="next"
    />
    <!-- Below 1024 px the top bar shows the title in its first row instead. -->
    <span
      class="ms-2 hidden min-w-44 font-semibold whitespace-nowrap lg:inline"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ rangeLabel }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { dateStepLabel } from '~/utils/date-nav'

const { rangeKind, rangeLabel, prev, next, today } = useCalendarState()
</script>
