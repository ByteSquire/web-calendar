<!--
  Top bar (FR-22..FR-25): sidebar toggle, title, date navigation, view-type switcher, quick-add,
  add and the overflow menu. Below 1024 px it has two rows (main.css): the toggle, title and the
  quick-add / add / overflow buttons stay on the first, so they are always visible at 360 px, while the
  date navigation and the view switcher share a second row that scrolls sideways on its own.
  The root keeps the `top-bar` class the layout places and sizes. While data loads a thin progress
  line runs along its lower edge; it is positioned absolutely, so nothing moves when it appears.
-->
<template>
  <header class="top-bar">
    <div class="top-bar-nav">
      <UButton
        :icon="sidebarOpen ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'"
        color="neutral"
        variant="ghost"
        aria-controls="app-sidebar"
        :aria-expanded="sidebarOpen"
        :aria-label="sidebarOpen ? 'Close sidebar' : 'Open sidebar'"
        @click="toggleSidebar"
      />
    </div>
    <div class="top-bar-title">
      <span class="hidden lg:inline">Web Calendar</span>
      <!-- Below 1024 px the shown period takes the place of the app name; DateNav hides its label. -->
      <!-- Two action buttons share the row at 360 px: there the label is smaller and may use two lines. -->
      <span
        class="min-w-0 line-clamp-2 text-sm leading-tight whitespace-normal sm:line-clamp-none sm:truncate sm:text-base sm:whitespace-nowrap lg:hidden"
        aria-live="polite"
        aria-atomic="true"
        >{{ rangeLabel }}</span
      >
    </div>
    <div class="top-bar-strip scroll-px-2">
      <DateNav class="shrink-0" />
      <ViewSwitcher class="shrink-0" />
    </div>
    <div class="top-bar-actions">
      <UButton icon="i-lucide-zap" color="primary" aria-label="Quick add" @click="openQuickAdd()">
        <span class="hidden sm:inline">Quick add</span>
      </UButton>
      <UButton
        icon="i-lucide-plus"
        color="primary"
        variant="outline"
        aria-label="Add"
        @click="openAddEvent()"
      >
        <span class="hidden sm:inline">Add</span>
      </UButton>
      <OverflowMenu />
    </div>
    <!-- Indeterminate: no value attributes. -->
    <div
      v-if="loading"
      class="top-bar-progress"
      role="progressbar"
      aria-label="Loading calendars"
    />
  </header>
</template>

<script setup lang="ts">
import { useLiveStatus } from '~/composables/useLiveCalendar'

const { sidebarOpen, toggleSidebar, openQuickAdd, openAddEvent, rangeLabel } = useCalendarState()
const { loading } = useLiveStatus()
</script>

<style scoped>
.top-bar-progress {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}

.top-bar-progress::after {
  content: '';
  display: block;
  width: 35%;
  height: 100%;
  background: var(--accent);
  animation: top-bar-progress 1.2s ease-in-out infinite;
}

@keyframes top-bar-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

/* No sweeping motion for people who ask for less: a still line says the same. */
@media (prefers-reduced-motion: reduce) {
  .top-bar-progress::after {
    width: 100%;
    animation: none;
    opacity: 0.6;
  }
}
</style>
