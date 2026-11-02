<!--
  A region of an event form that folds away: the start and end, the details. The header is a
  button (Nuxt UI's collapsible gives it aria-expanded and aria-controls); its chevron points down
  while the region is open and to the right while it is closed, as in the sidebar. While the region is
  closed, `summary` is shown under the title, so what is inside can still be read. The content is
  hidden, not removed: the parent owns the form, and the fields keep their place and their order
  in the keyboard focus when the region is opened again.
-->
<template>
  <UCollapsible
    v-model:open="open"
    :unmount-on-hide="false"
    class="flex flex-col gap-4"
    :ui="{ content: 'flex flex-col gap-4' }"
  >
    <UButton
      type="button"
      color="neutral"
      variant="outline"
      block
      icon="i-lucide-chevron-down"
      :ui="{
        base: 'justify-start py-2 text-start',
        leadingIcon: open
          ? 'motion-safe:transition-transform'
          : '-rotate-90 motion-safe:transition-transform',
      }"
    >
      <span class="flex min-w-0 flex-col items-start">
        <span class="font-medium">{{ title }}</span>
        <span v-if="!open && summary" class="max-w-full truncate text-sm font-normal text-toned">
          {{ summary }}
        </span>
      </span>
    </UButton>
    <template #content>
      <slot />
    </template>
  </UCollapsible>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ title: string; summary?: string }>(), { summary: '' })

const open = defineModel<boolean>('open', { default: true })
</script>
