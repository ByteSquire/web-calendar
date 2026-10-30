<!--
  The message above a dialog's form when saving failed. The `role="alert"` wrapper is always in the
  page, so a screen reader announces the text when it appears; a message that is rendered together
  with its live region is often missed. Colours: red 800 on red 50 and red 200 on red 950 both
  pass WCAG AA (7:1 and above).
-->
<template>
  <div role="alert" aria-atomic="true">
    <p
      v-if="message"
      class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    >
      {{ message }}
    </p>
  </div>
</template>

<script setup lang="ts">
defineProps<{ message: string }>()
</script>
