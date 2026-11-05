<!--
  A section of the sidebar (FR-21): a heading that is also the button which folds the section
  away and back, and the section's content. The chevron shows the state; the state is kept per
  title in this browser (app/utils/sidebar-sections.ts). `title` is the English text, marked with
  N_() by the caller: it stays the key of the saved state in every language, and the heading shows
  its translation. The content is only hidden, not removed, so what was typed into the field
  that adds something is still there when the section is opened again.

  The heading is also what a section is dragged by (app/composables/useSidebarDrag.ts, which
  finds the section by its `data-section-id`). While one is dragged every section shows only its
  heading, and `data-dragging` marks the one in the hand.

  A section that lets people add something (`addNoun`) has a plus to the right of its heading,
  next to the fold button and not inside it. On a large screen the plus shows the field under the
  heading and turns into a cross; on a small screen it opens a pop-up near the top of the screen,
  where the on-screen keyboard does not cover it. A folded section is opened first, so that the
  new entry is seen.
-->
<template>
  <section
    :aria-labelledby="headingId"
    class="flex flex-col rounded-lg data-[dragging=true]:relative data-[dragging=true]:z-10 data-[dragging=true]:bg-elevated data-[dragging=true]:shadow-lg data-[dragging=true]:ring-2 data-[dragging=true]:ring-primary"
  >
    <div class="flex items-center">
      <h2
        :id="headingId"
        class="min-w-0 flex-1 text-xs font-semibold tracking-wide text-muted uppercase"
      >
        <button
          type="button"
          class="flex min-h-11 w-full cursor-grab items-center gap-1 rounded-lg px-2 text-start uppercase select-none [-webkit-touch-callout:none] hover:bg-elevated"
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
          {{ tv(title) }}
        </button>
      </h2>
      <UButton
        v-if="adding"
        ref="plus"
        :icon="addOpen ? 'i-lucide-x' : 'i-lucide-plus'"
        color="neutral"
        variant="ghost"
        square
        class="min-h-11 min-w-11 shrink-0 justify-center"
        :aria-label="tv(ADD_TEXTS[addNoun!].add)"
        :aria-expanded="isDesktop ? addOpen : undefined"
        :aria-controls="isDesktop && addOpen ? addId : undefined"
        :aria-haspopup="isDesktop ? undefined : 'dialog'"
        @click="toggleAdd"
      />
    </div>
    <div v-show="open && dragging === null" :id="bodyId" class="flex flex-col">
      <div v-if="adding && addOpen && isDesktop" :id="addId">
        <SidebarAddInput
          :noun="addNoun!"
          :submit="addSubmit!"
          @added="closeAdd"
          @cancel="closeAdd"
        />
      </div>
      <slot />
    </div>
    <UModal
      v-if="adding && !isDesktop"
      :open="addOpen"
      :title="tv(ADD_TEXTS[addNoun!].add)"
      :description="tv(ADD_TEXTS[addNoun!].label)"
      :close="false"
      :ui="{ content: 'top-4 translate-y-0', description: 'sr-only' }"
      :content="{ onOpenAutoFocus: focusPopupField, onCloseAutoFocus: restoreFocus }"
      @update:open="(next: boolean) => (addOpen = next)"
    >
      <template #body>
        <SidebarAddInput
          ref="popupField"
          popup
          :noun="addNoun!"
          :submit="addSubmit!"
          @added="closeAdd"
          @cancel="closeAdd"
        />
      </template>
    </UModal>
  </section>
</template>

<script setup lang="ts">
import { browserStore } from '~/utils/browser-store'
import { tv } from '~/utils/i18n'
import {
  ADD_TEXTS,
  readClosedSections,
  toggleSection,
  writeClosedSections,
  type AddNoun,
} from '~/utils/sidebar-sections'

const props = defineProps<{
  title: string
  /** What the plus adds. Without it the section has no plus. */
  addNoun?: AddNoun
  /** Adds the entry: gets the trimmed name, returns what is wrong or nothing (SidebarAddInput). */
  addSubmit?: (value: string) => string | undefined | Promise<string | undefined>
}>()

const headingId = useId()
const bodyId = useId()
const addId = useId()

// One list for all sections (and for both copies of the sidebar, the column and the drawer).
const closed = useState<string[]>('sidebar-closed-sections', () =>
  readClosedSections(browserStore()),
)
const open = computed(() => !closed.value.includes(props.title))
const dragging = useSidebarDragState()

function toggle() {
  closed.value = toggleSection(closed.value, props.title)
  writeClosedSections(browserStore(), closed.value)
}

// ---- The plus -----------------------------------------------------------------------------------

const isDesktop = useIsDesktop()
const adding = computed(() => props.addNoun !== undefined && props.addSubmit !== undefined)
const addOpen = ref(false)
const plus = useTemplateRef<{ $el: HTMLElement }>('plus')
const popupField = useTemplateRef<{ focus: () => void }>('popupField')

// Android's back gesture closes the pop-up before it leaves the page.
const popupOpen = computed(() => addOpen.value && !isDesktop.value)
if (props.addNoun !== undefined) useBackDismiss(popupOpen, closeAdd)

function toggleAdd() {
  if (addOpen.value) {
    closeAdd()
    return
  }
  if (!open.value) toggle()
  addOpen.value = true
}

function focusPlus() {
  plus.value?.$el.focus()
}

function closeAdd() {
  addOpen.value = false
  // The inline field leaves the page at once, so the focus goes back to the plus now. The pop-up
  // hands it back itself when it has closed (`restoreFocus`).
  if (isDesktop.value) void nextTick(focusPlus)
}

// The pop-up is opened to type in, so the field takes the focus even on a touch screen, where a
// dialog otherwise keeps it off its controls (utils/focus.ts).
function focusPopupField(event: Event) {
  event.preventDefault()
  popupField.value?.focus()
}

// Reka UI only returns the focus to a trigger it knows; the plus is not one.
function restoreFocus(event: Event) {
  event.preventDefault()
  focusPlus()
}
</script>
