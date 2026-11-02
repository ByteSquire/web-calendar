<!--
  A section of the sidebar (FR-21): a heading that is also the button which folds the section
  away and back, and the section's content. The chevron shows the state; the state is kept per
  title in this browser (app/utils/sidebar-sections.ts). The content is only hidden, not removed,
  so what was typed into an "Add" input is still there when the section is opened again.
-->
<template>
  <section :aria-labelledby="headingId" class="flex flex-col">
    <h2 :id="headingId" class="text-xs font-semibold tracking-wide text-muted uppercase">
      <button
        type="button"
        class="flex min-h-11 w-full items-center gap-1 rounded-lg px-2 text-start uppercase hover:bg-elevated"
        :aria-expanded="open"
        :aria-controls="bodyId"
        @click="toggle"
      >
        <UIcon
          name="i-lucide-chevron-down"
          class="size-4 shrink-0 motion-safe:transition-transform"
          :class="open ? '' : '-rotate-90'"
          aria-hidden="true"
        />
        {{ title }}
      </button>
    </h2>
    <div v-show="open" :id="bodyId" class="flex flex-col">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import { readClosedSections, toggleSection, writeClosedSections } from '~/utils/sidebar-sections'

const props = defineProps<{ title: string }>()

const headingId = useId()
const bodyId = useId()

function browserStore(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// One list for all sections (and for both copies of the sidebar, the column and the drawer).
const closed = useState<string[]>('sidebar-closed-sections', () =>
  readClosedSections(browserStore()),
)
const open = computed(() => !closed.value.includes(props.title))

function toggle() {
  closed.value = toggleSection(closed.value, props.title)
  writeClosedSections(browserStore(), closed.value)
}
</script>
