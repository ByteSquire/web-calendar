<!--
  Top bar (FR-22..FR-25): sidebar toggle, title, date navigation, view-type switcher, quick-add,
  add and the overflow menu. Below 1024 px it has two rows (main.css): the toggle, title and the
  quick-add / add / overflow buttons stay on the first, so they are always visible at 360 px, while the
  date navigation and the view switcher share a second row that scrolls sideways on its own.
  On the page of a calendar link (read-only) it has no sidebar toggle, no adding and names the
  calendar instead of the app. The root keeps the `top-bar` class the layout places and sizes. While data loads a thin progress
  line runs along its lower edge; it is positioned absolutely, so nothing moves when it appears.
-->
<template>
  <header class="top-bar">
    <div class="top-bar-nav">
      <UButton
        v-if="!linkView"
        :icon="sidebarOpen ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'"
        color="neutral"
        variant="ghost"
        aria-controls="app-sidebar"
        :aria-expanded="sidebarOpen"
        :aria-label="sidebarOpen ? t('Close sidebar') : t('Open sidebar')"
        @click="toggleSidebar"
      />
    </div>
    <div class="top-bar-title">
      <!-- The name leads back to the calendar (the base address) from every page that has this bar. -->
      <!-- The page of a calendar link names its calendar; there is no app to go back to. -->
      <span v-if="linkView" class="hidden truncate lg:inline">{{ linkView.name }}</span>
      <NuxtLink
        v-else
        to="/"
        class="hidden rounded-sm text-inherit no-underline hover:underline focus-visible:underline lg:inline"
        >Web Calendar</NuxtLink
      >
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
      <UButton
        v-if="!linkView"
        icon="i-lucide-zap"
        color="primary"
        :aria-label="t('Quick add')"
        @click="openQuickAdd()"
      >
        <span class="hidden sm:inline">{{ t('Quick add') }}</span>
      </UButton>
      <UButton
        v-if="!linkView"
        icon="i-lucide-plus"
        color="primary"
        variant="outline"
        :aria-label="t('Add')"
        @click="openAddEvent()"
      >
        <span class="hidden sm:inline">{{ t('Add') }}</span>
      </UButton>
      <OverflowMenu />
    </div>
    <!-- Indeterminate: no value attributes. -->
    <div
      v-if="loading"
      class="top-bar-progress"
      role="progressbar"
      :aria-label="t('Loading calendars')"
    />
  </header>
</template>

<script setup lang="ts">
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { t } from '~/utils/i18n'

const { sidebarOpen, toggleSidebar, openQuickAdd, openAddEvent, rangeLabel } = useCalendarState()
const { loading } = useLiveStatus()
const linkView = useCalendarLinkView()
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
