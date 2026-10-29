<!--
  Top bar (FR-22..FR-25): sidebar toggle, title, date navigation, view-type switcher, quick-add
  and the overflow menu. Below 1024 px it has two rows (main.css): the toggle, title and the
  quick-add / overflow buttons stay on the first, so they are always visible at 360 px, while the
  date navigation and the view switcher share a second row that scrolls sideways on its own.
  The root keeps the `top-bar` class the layout places and sizes.
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
      <span class="lg:hidden" aria-live="polite" aria-atomic="true">{{ rangeLabel }}</span>
    </div>
    <div class="top-bar-strip scroll-px-2">
      <DateNav class="shrink-0" />
      <ViewSwitcher class="shrink-0" />
    </div>
    <div class="top-bar-actions">
      <UButton icon="i-lucide-plus" color="primary" aria-label="Quick add" @click="openQuickAdd()">
        <span class="hidden sm:inline">Quick add</span>
      </UButton>
      <OverflowMenu />
    </div>
  </header>
</template>

<script setup lang="ts">
const { sidebarOpen, toggleSidebar, openQuickAdd, rangeLabel } = useCalendarState()
</script>
