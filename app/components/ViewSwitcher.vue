<!-- View-type switcher (FR-22). The pressed button is the current view type. -->
<template>
  <div
    role="group"
    :aria-label="t('View type')"
    class="flex items-center gap-1 rounded-lg bg-default p-0.5 ring ring-default"
  >
    <UButton
      v-for="type in VIEW_TYPES"
      :key="type"
      :label="tv(VIEW_TYPE_LABELS[type])"
      color="neutral"
      :variant="viewType === type ? 'solid' : 'ghost'"
      :aria-pressed="viewType === type"
      @click="viewType = type"
    />
  </div>
</template>

<script setup lang="ts">
import { VIEW_TYPES, VIEW_TYPE_LABELS } from '~/utils/calendar-state'
import { t, tv } from '~/utils/i18n'

const { viewType } = useCalendarState()
</script>
