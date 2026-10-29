<template>
  <div class="flex items-center gap-1">
    <UButton
      :icon="viewIconName(view.icon)"
      :label="view.name"
      :color="selected ? 'primary' : 'neutral'"
      :variant="selected ? 'soft' : 'ghost'"
      :trailing-icon="selected ? 'i-lucide-check' : undefined"
      :aria-pressed="selected"
      :ui="{ trailingIcon: 'ms-auto' }"
      class="min-w-0 flex-1 justify-start"
      @click="emit('select')"
    />
    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        :aria-label="`Actions for view ${view.name}`"
      />
    </UDropdownMenu>
  </div>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { CalendarView } from '../../shared/types/calendar'

const props = defineProps<{ view: CalendarView; selected: boolean }>()
const emit = defineEmits<{ select: [] }>()

const toast = useToast()

// Phase 1 is a mock-up: the actions only acknowledge the click.
function mockAction(action: string) {
  toast.add({
    title: `${action}: ${props.view.name}`,
    description: 'The mock-up does not change views.',
    icon: 'i-lucide-info',
  })
}

// Admin views are shared with everyone; the mock user is not an admin.
const items = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: 'Rename',
      icon: 'i-lucide-pencil',
      disabled: props.view.isAdmin,
      onSelect: () => mockAction('Rename'),
    },
    { label: 'Duplicate', icon: 'i-lucide-copy', onSelect: () => mockAction('Duplicate') },
  ],
  [
    {
      label: 'Delete',
      icon: 'i-lucide-trash-2',
      color: 'error',
      disabled: props.view.isAdmin,
      onSelect: () => mockAction('Delete'),
    },
  ],
])
</script>
