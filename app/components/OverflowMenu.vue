<!--
  Overflow (⋮) menu (FR-25). Nuxt UI closes it on Escape and on a click outside, moves focus into
  the menu and returns it to the trigger. The items are placeholders in the mock-up.
-->
<template>
  <UDropdownMenu :items="items" :content="{ align: 'end' }">
    <UButton
      icon="i-lucide-ellipsis-vertical"
      color="neutral"
      variant="ghost"
      aria-label="More options"
    />
  </UDropdownMenu>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const toast = useToast()

function mockAction(action: string) {
  toast.add({
    title: action,
    description: 'Not available in the mock-up yet.',
    icon: 'i-lucide-info',
  })
}

const items: DropdownMenuItem[][] = [
  [{ label: 'Refresh', icon: 'i-lucide-refresh-cw', onSelect: () => mockAction('Refresh') }],
  [
    { label: 'Settings', icon: 'i-lucide-settings', onSelect: () => mockAction('Settings') },
    { label: 'Help', icon: 'i-lucide-circle-help', onSelect: () => mockAction('Help') },
  ],
]
</script>
