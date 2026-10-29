<!--
  One labelled row of the event sheet: an icon and a small label (the term) and the content (the
  description, default slot). The term and the description are direct children of the row, which is
  a group of the surrounding description list.
-->
<template>
  <div>
    <dt class="flex items-center gap-3 text-xs font-medium tracking-wide text-muted uppercase">
      <UIcon :name="icon" class="size-5 shrink-0" aria-hidden="true" />
      {{ label }}
    </dt>
    <dd class="mt-1 ps-8 text-default break-words"><slot /></dd>
  </div>
</template>

<script setup lang="ts">
defineProps<{ icon: string; label: string }>()
</script>
