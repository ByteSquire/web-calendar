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
import { settledMenuItems } from '~/utils/menu-select'
import type { CalendarView } from '../../shared/types/calendar'

// Every view has a menu (FR-21). Every view the viewer may change offers Edit (its name and its
// calendars, in the view dialog) and Update from selection (the calendars switched on now): a
// user's own view, and a shared one for an administrator (`canManage`; a convenience, the server
// enforces). A shared view offers "Copy to my views" to everyone, and to an administrator Unshare
// and Delete too. A user's own view offers Duplicate and Delete, and an administrator may also
// share it with everybody. Every view can be hidden from the sidebar (Hide). An item runs once per
// click or tap, and the rest of the tap is swallowed (utils/menu-select.ts): the dialogs of Edit
// and Delete would otherwise take its click.
const props = defineProps<{ view: CalendarView; selected: boolean; canManage?: boolean }>()
const emit = defineEmits<{
  select: []
  edit: []
  update: []
  delete: []
  copy: []
  share: []
  unshare: []
  hide: []
}>()

const items = computed<DropdownMenuItem[][]>(() => settledMenuItems(menu()))

function menu(): DropdownMenuItem[][] {
  // Made here, while rendering, so that the labels follow a change of language.
  const copy: DropdownMenuItem = {
    label: t('Copy to my views'),
    icon: 'i-lucide-copy-plus',
    onSelect: () => emit('copy'),
  }
  const edit: DropdownMenuItem = {
    label: t('Edit'),
    icon: 'i-lucide-pencil',
    onSelect: () => emit('edit'),
  }
  const update: DropdownMenuItem = {
    label: t('Update from selection'),
    icon: 'i-lucide-refresh-cw',
    onSelect: () => emit('update'),
  }
  const remove: DropdownMenuItem = {
    label: t('Delete'),
    icon: 'i-lucide-trash-2',
    color: 'error',
    onSelect: () => emit('delete'),
  }
  // Everybody may hide a view from their own sidebar, a shared one included.
  const hide: DropdownMenuItem = {
    label: t('Hide'),
    icon: 'i-lucide-eye-off',
    onSelect: () => emit('hide'),
  }
  if (props.view.isAdmin) {
    return props.canManage
      ? [
          [
            edit,
            update,
            copy,
            { label: t('Unshare'), icon: 'i-lucide-lock', onSelect: () => emit('unshare') },
            hide,
          ],
          [remove],
        ]
      : [[copy, hide]]
  }
  const own: DropdownMenuItem[] = [
    edit,
    update,
    { label: t('Duplicate'), icon: 'i-lucide-copy', onSelect: () => emit('copy') },
  ]
  if (props.canManage) {
    own.push({
      label: t('Share with everybody'),
      icon: 'i-lucide-users',
      onSelect: () => emit('share'),
    })
  }
  own.push(hide)
  return [own, [remove]]
}
</script>
