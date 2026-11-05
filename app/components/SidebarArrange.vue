<!--
  Arranging the sidebar's sections without dragging (WCAG 2.5.7): the sections in their order, each
  with a button that moves it up and one that moves it down. Dragging the headings does the same
  (app/composables/useSidebarDrag.ts); this is for the keyboard, for assistive technology and for
  anybody who cannot drag. The order is saved for the account (useSidebarOrder).
-->
<template>
  <section :aria-labelledby="headingId" class="flex flex-col gap-2">
    <h2
      :id="headingId"
      ref="heading"
      tabindex="-1"
      class="px-2 text-xs font-semibold tracking-wide text-muted uppercase focus:outline-none"
    >
      {{ t('Arrange sections') }}
    </h2>
    <p class="px-2 text-sm text-toned">
      {{ t('Move a section up or down. The order is saved for your account.') }}
    </p>
    <ol ref="list" class="flex flex-col">
      <li v-for="(id, index) in order" :key="id" class="flex min-h-11 items-center gap-1 ps-2">
        <span class="min-w-0 flex-1 truncate">{{ tv(SECTION_TITLES[id]) }}</span>
        <UButton
          icon="i-lucide-arrow-up"
          color="neutral"
          variant="ghost"
          square
          class="min-h-11 min-w-11 justify-center"
          :data-move="`${id}:up`"
          :disabled="index === 0"
          :aria-label="t('Move {name} up', { name: tv(SECTION_TITLES[id]) })"
          @click="onMove(id, -1)"
        />
        <UButton
          icon="i-lucide-arrow-down"
          color="neutral"
          variant="ghost"
          square
          class="min-h-11 min-w-11 justify-center"
          :data-move="`${id}:down`"
          :disabled="index === order.length - 1"
          :aria-label="t('Move {name} down', { name: tv(SECTION_TITLES[id]) })"
          @click="onMove(id, 1)"
        />
      </li>
    </ol>
    <p role="status" class="sr-only">{{ announcement }}</p>
    <UButton
      :label="t('Done')"
      icon="i-lucide-check"
      color="neutral"
      variant="subtle"
      class="min-h-11 self-start"
      @click="emit('done')"
    />
  </section>
</template>

<script setup lang="ts">
import { t, tv } from '~/utils/i18n'
import { SECTION_TITLES } from '~/utils/sidebar-sections'
import type { SidebarSectionId } from '../../shared/utils/sidebar-sections'

const emit = defineEmits<{ done: [] }>()

const { order, move } = useSidebarOrder()
const headingId = useId()
const heading = useTemplateRef<HTMLElement>('heading')
const list = useTemplateRef<HTMLElement>('list')
const announcement = ref('')

onMounted(() => heading.value?.focus())

async function onMove(id: SidebarSectionId, delta: -1 | 1) {
  if (!move(id, delta)) return
  announcement.value = t('{name}: number {position} of {total}', {
    name: tv(SECTION_TITLES[id]),
    position: order.value.indexOf(id) + 1,
    total: order.value.length,
  })
  await nextTick()
  // Moving a row takes it out of the page and puts it back, which drops the focus. It goes back
  // to the button that was pressed, or to its twin when this one is disabled now (the end).
  const same = delta < 0 ? 'up' : 'down'
  const other = delta < 0 ? 'down' : 'up'
  for (const direction of [same, other]) {
    const button = list.value?.querySelector<HTMLButtonElement>(
      `[data-move="${id}:${direction}"]:not(:disabled)`,
    )
    if (button) {
      button.focus()
      return
    }
  }
}
</script>
