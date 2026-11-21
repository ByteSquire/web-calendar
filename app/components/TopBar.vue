<!--
  Top bar (FR-22..FR-25): sidebar toggle, title, date navigation, view-type switcher, "Add" and
  the overflow menu. Below 1024 px it has two rows (main.css): the toggle, title and the add and
  overflow buttons stay on the first, so they are always visible at 360 px, while the date
  navigation and the view switcher share a second row that scrolls sideways on its own. From
  1024 px all of it shares one row; when that row runs short (a large zoom or display scaling, a
  longer language), "Add" shows only its plus, as on a phone, before the strip has to scroll
  (utils/top-bar-fit.ts).
  On the page of a calendar link (read-only) it has no sidebar toggle, no adding and names the
  calendar instead of the app. The root keeps the `top-bar` class the layout places and sizes. While data loads a thin progress
  line runs along its lower edge; it is positioned absolutely, so nothing moves when it appears.
  On paper only a heading is left (`data-print-title`, main.css): the shown period, under the
  calendar's name on the page of a link.
-->
<template>
  <header class="top-bar" :data-print-title="printTitle">
    <div class="top-bar-nav">
      <UButton
        v-if="!linkView"
        :icon="sidebarOpen ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'"
        color="neutral"
        variant="ghost"
        aria-controls="app-sidebar"
        :aria-expanded="sidebarOpen"
        :aria-label="sidebarOpen ? t('Close sidebar') : t('Open sidebar')"
        @click="toggleSidebar"
      />
    </div>
    <div class="top-bar-title">
      <!-- The name leads back to the calendar (the base address) from every page that has this bar;
           outlined like the buttons beside it and with a house, so it reads as the way home. -->
      <!-- The page of a calendar link names its calendar; there is no app to go back to. -->
      <span v-if="linkView" class="hidden truncate lg:inline">{{ linkView.name }}</span>
      <UButton
        v-else
        to="/"
        label="Web Calendar"
        icon="i-lucide-house"
        color="neutral"
        variant="outline"
        class="hidden font-semibold lg:inline-flex"
      />
      <!-- Below 1024 px the shown period takes the place of the app name; DateNav hides its label. -->
      <!-- Two action buttons share the row at 360 px: there the label is smaller and may use two lines. -->
      <span
        class="min-w-0 line-clamp-2 text-sm leading-tight whitespace-normal sm:line-clamp-none sm:truncate sm:text-base sm:whitespace-nowrap lg:hidden"
        aria-live="polite"
        aria-atomic="true"
        >{{ rangeLabel }}</span
      >
    </div>
    <div ref="strip" class="top-bar-strip scroll-px-2">
      <DateNav class="shrink-0" />
      <ViewSwitcher class="shrink-0" />
    </div>
    <div class="top-bar-actions">
      <!-- Named by aria-label also when only the plus shows; the title names it on hover then. -->
      <UButton
        v-if="!linkView"
        ref="addButton"
        icon="i-lucide-plus"
        color="primary"
        :aria-label="t('Add')"
        :title="addFit.compact ? t('Add') : undefined"
        @click="openAddEvent()"
      >
        <span :class="addFit.compact ? 'hidden' : 'hidden sm:inline'">{{ t('Add') }}</span>
      </UButton>
      <OverflowMenu />
    </div>
    <!-- Indeterminate: no value attributes. -->
    <div
      v-if="loading"
      class="top-bar-progress"
      role="progressbar"
      :aria-label="t('Loading calendars')"
    />
  </header>
</template>

<script setup lang="ts">
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { locale, t } from '~/utils/i18n'
import { ADD_LABEL_SHOWN, contentWidth, fitAddLabel } from '~/utils/top-bar-fit'

const { sidebarOpen, toggleSidebar, openAddEvent, rangeLabel } = useCalendarState()
const { loading } = useLiveStatus()
const linkView = useCalendarLinkView()
// The heading on paper (main.css draws it from the attribute, so the page has no second copy of
// the period for assistive technology or a search to find).
const printTitle = computed(() =>
  linkView.value ? `${linkView.value.name}\n${rangeLabel.value}` : rangeLabel.value,
)

// "Add" with or without its label (utils/top-bar-fit.ts). The strip and what is in it are
// observed: the bar's width, the period label and the view names all change the room there is.
// The check waits for the next frame, so the change it makes is not reported back to the observer
// in the same pass.
const strip = useTemplateRef<HTMLElement>('strip')
const addButton = useTemplateRef<{ $el?: HTMLElement }>('addButton')
const addFit = ref(ADD_LABEL_SHOWN)
let stripObserver: ResizeObserver | undefined
let frame = 0

function fitAdd() {
  frame = 0
  const element = strip.value
  const button = addButton.value?.$el
  if (!element || !(button instanceof HTMLElement)) return
  const actions = button.parentElement?.getBoundingClientRect()
  addFit.value = fitAddLabel(addFit.value, {
    // Below 1024 px the strip has a row of its own, under the buttons.
    oneRow: !!actions && element.getBoundingClientRect().top < actions.bottom,
    slack: element.clientWidth - contentWidth(element),
    buttonWidth: button.getBoundingClientRect().width,
  })
}

function scheduleFit() {
  if (frame === 0) frame = requestAnimationFrame(fitAdd)
}

onMounted(() => {
  if (!strip.value || typeof ResizeObserver === 'undefined') return
  stripObserver = new ResizeObserver(scheduleFit)
  stripObserver.observe(strip.value)
  for (const child of strip.value.children) stripObserver.observe(child)
})

onBeforeUnmount(() => {
  stripObserver?.disconnect()
  if (frame !== 0) cancelAnimationFrame(frame)
})

// Another language has another label: measure it again from the full button.
watch(locale, () => {
  addFit.value = ADD_LABEL_SHOWN
  scheduleFit()
})
</script>

<style scoped>
.top-bar-progress {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}

.top-bar-progress::after {
  content: '';
  display: block;
  width: 35%;
  height: 100%;
  background: var(--accent);
  animation: top-bar-progress 1.2s ease-in-out infinite;
}

@keyframes top-bar-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

/* No sweeping motion for people who ask for less: a still line says the same. */
@media (prefers-reduced-motion: reduce) {
  .top-bar-progress::after {
    width: 100%;
    animation: none;
    opacity: 0.6;
  }
}
</style>
