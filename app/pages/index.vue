<template>
  <div class="page-placeholder">
    <h1>Web Calendar</h1>
    <p>Phase 1 — app shell in place (sidebar, top bar, main area).</p>
    <p class="muted">FullCalendar and mock data arrive in later steps.</p>
  </div>
</template>

<script setup lang="ts">
// Placeholder page; replaced by the calendar UI in later steps.
</script>

<style scoped>
.page-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%; /* fill main area; grow + scroll if content is taller */
  gap: 8px;
  text-align: center;
}

.page-placeholder h1 {
  margin: 0;
}

.muted {
  color: var(--text-muted);
}
</style>
