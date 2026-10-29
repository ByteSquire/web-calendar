<template>
  <SplitView v-if="viewType === 'split'" />
  <CalendarMain v-else />
</template>

<script setup lang="ts">
const { viewType } = useCalendarState()
</script>
