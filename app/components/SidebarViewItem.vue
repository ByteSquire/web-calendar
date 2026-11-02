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
    <UBadge v-if="view.isAdmin" :label="t('Shared')" color="neutral" variant="subtle" size="sm" />
    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        :aria-label="t('Actions for view {name}', { name: view.name })"
      />
    </UDropdownMenu>
  </div>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { t } from '~/utils/i18n'
import type { CalendarView } from '../../shared/types/calendar'

// Every view has a menu (FR-21). A shared view offers "Copy to my views" to everyone; its own
// actions (Rename, Update from selection, Unshare, Delete) need `canManage`: the viewer is an
// administrator (a convenience; the server enforces). A user's own view offers Rename, Duplicate
// and Delete, and an administrator may also share it with everybody; Unshare takes it back.
const props = defineProps<{ view: CalendarView; selected: boolean; canManage?: boolean }>()
const emit = defineEmits<{
  select: []
  rename: []
  update: []
  delete: []
  copy: []
  share: []
  unshare: []
}>()

const items = computed<DropdownMenuItem[][]>(() => {
  // Made here, while rendering, so that the labels follow a change of language.
  const copy: DropdownMenuItem = {
    label: t('Copy to my views'),
    icon: 'i-lucide-copy-plus',
    onSelect: () => emit('copy'),
  }
  const rename: DropdownMenuItem = {
    label: t('Rename'),
    icon: 'i-lucide-pencil',
    onSelect: () => emit('rename'),
  }
  const remove: DropdownMenuItem = {
    label: t('Delete'),
    icon: 'i-lucide-trash-2',
    color: 'error',
    onSelect: () => emit('delete'),
  }
  if (props.view.isAdmin) {
    return props.canManage
      ? [
          [
            rename,
            {
              label: t('Update from selection'),
              icon: 'i-lucide-refresh-cw',
              onSelect: () => emit('update'),
            },
            copy,
            { label: t('Unshare'), icon: 'i-lucide-lock', onSelect: () => emit('unshare') },
          ],
          [remove],
        ]
      : [[copy]]
  }
  const own: DropdownMenuItem[] = [
    rename,
    { label: t('Duplicate'), icon: 'i-lucide-copy', onSelect: () => emit('copy') },
  ]
  if (props.canManage) {
    own.push({
      label: t('Share with everybody'),
      icon: 'i-lucide-users',
      onSelect: () => emit('share'),
    })
  }
  return [own, [remove]]
})
</script>
