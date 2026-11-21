<!--
  Date navigation (FR-23): previous / today / next and the title of the shown period. The three
  buttons are outlined, so they read as buttons beside the title. The title is a polite live region, so a screen reader announces the new period after each step.
-->
<template>
  <div role="group" :aria-label="t('Date navigation')" class="flex items-center gap-1">
    <UButton
      icon="i-lucide-chevron-left"
      color="neutral"
      variant="outline"
      :aria-label="dateStepLabel('previous', rangeKind, customDays)"
      @click="prev"
    />
    <UButton :label="t('Today')" color="neutral" variant="outline" @click="today" />
    <UButton
      icon="i-lucide-chevron-right"
      color="neutral"
      variant="outline"
      :aria-label="dateStepLabel('next', rangeKind, customDays)"
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
import { t } from '~/utils/i18n'

const { rangeKind, rangeLabel, customDays, prev, next, today } = useCalendarState()
</script>
