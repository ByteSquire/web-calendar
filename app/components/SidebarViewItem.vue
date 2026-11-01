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
    <UBadge v-if="view.isAdmin" label="Shared" color="neutral" variant="subtle" size="sm" />
    <UDropdownMenu v-if="items.length > 0" :items="items" :content="{ align: 'end' }">
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

// `canManage`: the viewer is an administrator (a convenience; the server enforces). Without it a
// shared view has no actions.
const props = defineProps<{ view: CalendarView; selected: boolean; canManage?: boolean }>()
const emit = defineEmits<{ select: []; rename: []; update: []; delete: [] }>()

const toast = useToast()

// Phase 1 is a mock-up: the actions of a user's own view only acknowledge the click.
function mockAction(action: string) {
  toast.add({
    title: `${action}: ${props.view.name}`,
    description: 'The mock-up does not change views.',
    icon: 'i-lucide-info',
  })
}

const items = computed<DropdownMenuItem[][]>(() => {
  if (props.view.isAdmin) {
    return props.canManage
      ? [
          [
            { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => emit('rename') },
            {
              label: 'Update from selection',
              icon: 'i-lucide-refresh-cw',
              onSelect: () => emit('update'),
            },
          ],
          [
            {
              label: 'Delete',
              icon: 'i-lucide-trash-2',
              color: 'error',
              onSelect: () => emit('delete'),
            },
          ],
        ]
      : []
  }
  return [
    [
      { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => mockAction('Rename') },
      { label: 'Duplicate', icon: 'i-lucide-copy', onSelect: () => mockAction('Duplicate') },
    ],
    [
      {
        label: 'Delete',
        icon: 'i-lucide-trash-2',
        color: 'error',
        onSelect: () => mockAction('Delete'),
      },
    ],
  ]
})
</script>
