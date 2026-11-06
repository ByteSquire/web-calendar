<!--
  The "⋯" menu at the end of a sidebar row (a calendar, a category, a filter): the actions the viewer
  may take on that item, made by the caller while rendering. The button is named after the item, so
  a screen reader tells the rows' menus apart, and is at least 44 px square (design §9). An item
  runs once per click or tap, and the rest of the tap is swallowed (utils/menu-select.ts), so the
  dialog it opens never takes the tap's click.
-->
<template>
  <UDropdownMenu :items="settledMenuItems(items)" :content="{ align: 'end' }">
    <UButton
      icon="i-lucide-ellipsis"
      color="neutral"
      variant="ghost"
      square
      class="min-h-11 min-w-11 shrink-0 justify-center"
      :aria-label="label"
    />
  </UDropdownMenu>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { settledMenuItems } from '~/utils/menu-select'

defineProps<{
  /** The button's name, for example "Actions for calendar Team". */
  label: string
  items: DropdownMenuItem[][]
}>()
</script>
