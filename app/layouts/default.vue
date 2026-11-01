<!--
  Nothing of the user's data is drawn before the sign-in is known (the route guard normally keeps
  this layout from rendering at all; this also covers the moment of signing out).
-->
<template>
  <div class="app-shell" :class="{ 'sidebar-open': sidebarOpen }">
    <template v-if="ready">
      <TopBar />

      <!-- Desktop: fixed column. Below 768 px the same content opens in a slideover. -->
      <aside v-if="isDesktop" id="app-sidebar" class="sidebar" aria-label="Views and calendars">
        <SidebarContent />
      </aside>
      <USlideover
        v-else
        v-model:open="sidebarOpen"
        side="left"
        title="Views and calendars"
        description="Choose views, calendars, resources, categories and filters"
        :ui="{ content: 'w-80 max-w-[85vw]', description: 'sr-only' }"
        :content="{ onOpenAutoFocus: keepFocusOffControlsOnTouch, onCloseAutoFocus: restoreFocus }"
      >
        <template #body>
          <SidebarContent />
        </template>
      </USlideover>

      <!-- Main area fills the remaining height; page content scrolls internally. -->
      <main class="main-area" :aria-busy="loading">
        <slot />
      </main>

      <EventSheet />
      <QuickAddModal />
    </template>
  </div>
</template>

<script setup lang="ts">
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { useAuth } from '~/composables/useAuth'
import { useLiveCalendar, useLiveStatus } from '~/composables/useLiveCalendar'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { isLiveConfig } from '~/utils/live/seed'

const { sidebarOpen } = useCalendarState()
const isDesktop = useIsDesktop()

// Live data for the signed-in user; does nothing in demo mode.
useLiveCalendar()
// Follows a change of the display zone (FR-32); live data is loaded again by the loader above.
useDisplayZoneFollow()
const { loading } = useLiveStatus()
const auth = useAuth()
const live = isLiveConfig(useServerConfigState().value)
const ready = computed(() => !live || auth.status.value === 'authenticated')

// Open by default on desktop, closed on a phone (slideover, or the column of a phone turned
// sideways). Turning the phone keeps what the person chose: the state is not reset when the width
// crosses 768 px, the column and the slideover share it.

// The slideover has no trigger element, so Reka UI cannot return focus to the toggle by itself
// (same as QuickAddModal): remember what had focus when it opened.
let opener: HTMLElement | null = null
watch(sidebarOpen, (open) => {
  if (open && !isDesktop.value) opener = document.activeElement as HTMLElement | null
})

function restoreFocus(event: Event) {
  event.preventDefault()
  if (opener?.isConnected) opener.focus()
}
</script>
