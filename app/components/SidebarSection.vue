<template>
  <section :aria-labelledby="headingId" class="flex flex-col">
    <h2
      :id="headingId"
      class="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase"
    >
      {{ title }}
    </h2>
    <slot />
  </section>
</template>

<script setup lang="ts">
defineProps<{ title: string }>()

const headingId = useId()
</script>
