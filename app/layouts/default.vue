<template>
  <div class="app-shell" :class="{ 'sidebar-open': sidebarOpen }">
    <!-- Top bar spans the full width; controls scroll horizontally if crowded. -->
    <header class="top-bar">
      <button
        type="button"
        class="icon-btn"
        aria-controls="app-sidebar"
        :aria-expanded="sidebarOpen ? 'true' : 'false'"
        :aria-label="sidebarOpen ? 'Close sidebar' : 'Open sidebar'"
        @click="toggleSidebar"
      >
        <span class="hamburger" aria-hidden="true"><span></span><span></span><span></span></span>
      </button>

      <div class="top-bar-title">Web Calendar</div>

      <!-- Step 5: view switcher, date nav, quick-add, overflow menu -->
    </header>

    <!-- Backdrop dims the page behind the mobile drawer and closes it on tap. -->
    <div v-if="sidebarOpen" class="sidebar-backdrop" @click="closeSidebar"></div>

    <!-- Sidebar: fixed column on desktop; off-canvas drawer below 768px. -->
    <aside id="app-sidebar" class="sidebar" :class="{ 'is-open': sidebarOpen }">
      <button
        type="button"
        class="icon-btn sidebar-close"
        aria-label="Close sidebar"
        @click="closeSidebar"
      >
        <span aria-hidden="true">&times;</span>
      </button>

      <!-- Step 4: views, calendars, resources, categories, filters -->
    </aside>

    <!-- Main area fills the remaining height; page content scrolls internally. -->
    <main class="main-area">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

// Client-side drawer state. Starts closed (safe for mobile SSR); opened by default on desktop.
const sidebarOpen = ref(false)

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
}

function closeSidebar() {
  sidebarOpen.value = false
}

onMounted(() => {
  // Open the sidebar by default on desktop; keep it closed (drawer) on mobile.
  if (window.matchMedia('(min-width: 768px)').matches) {
    sidebarOpen.value = true
  }
})
</script>
