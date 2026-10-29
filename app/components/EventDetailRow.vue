<!-- One labelled row of the event sheet: an icon, a small label and the content (default slot). -->
<template>
  <div class="flex gap-3">
    <UIcon :name="icon" class="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <dt class="text-xs font-medium tracking-wide text-muted uppercase">{{ label }}</dt>
      <dd class="mt-0.5 text-default break-words"><slot /></dd>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ icon: string; label: string }>()
</script>
