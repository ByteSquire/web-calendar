<!--
  Event details sheet: a bottom sheet on phones, a side panel on desktop. Open while
  `selectedEventId` is set; closing (Escape, the close button, the backdrop) clears it. Blocked
  events show "Busy" and the time only. Edit and Delete are visible buttons and inert in Phase 1:
  they say that editing arrives with the real calendar service.
-->
<template>
  <USlideover
    :open="selectedEvent !== null"
    :side="isDesktop ? 'right' : 'bottom'"
    :title="shown?.title"
    :description="whenText"
    :transition="!reducedMotion"
    :content="{ onOpenAutoFocus: markScrollers, onCloseAutoFocus: restoreFocus }"
    :ui="{ content: isDesktop ? '' : 'max-h-[85dvh] rounded-t-xl', body: 'overscroll-contain' }"
    @update:open="onOpenChange"
  >
    <template #body>
      <dl v-if="shown" class="flex flex-col gap-5">
        <EventDetailRow icon="i-lucide-clock" label="When">
          <p>{{ shown.when.date }}</p>
          <p>
            {{ shown.when.time }}
            <span v-if="!shown.allDay" class="text-muted">({{ timeZone }})</span>
          </p>
          <p v-if="shown.orgWhen" class="text-muted text-sm">
            Organization time ({{ orgTimeZone }}): {{ shown.orgWhen.date }},
            {{ shown.orgWhen.time }}
          </p>
        </EventDetailRow>

        <EventDetailRow v-if="shown.calendar" icon="i-lucide-calendar" label="Calendar">
          <span class="inline-flex items-center gap-2">
            <span
              class="size-3 shrink-0 rounded-full"
              :style="{ backgroundColor: shown.calendar.color }"
              aria-hidden="true"
            />
            {{ shown.calendar.name }}
          </span>
        </EventDetailRow>

        <EventDetailRow v-if="shown.location" icon="i-lucide-map-pin" label="Location">
          {{ shown.location }}
        </EventDetailRow>

        <EventDetailRow
          v-if="shown.resource"
          :icon="resourceIconName(shown.resource.type)"
          label="Resource"
        >
          <p>{{ shown.resource.name }}</p>
          <p v-if="shown.resource.location" class="text-muted">{{ shown.resource.location }}</p>
          <p v-if="shown.bookedBy" class="text-muted">Booked by {{ shown.bookedBy }}</p>
        </EventDetailRow>

        <EventDetailRow v-if="shown.description" icon="i-lucide-text" label="Description">
          <p class="whitespace-pre-line">{{ shown.description }}</p>
        </EventDetailRow>

        <EventDetailRow v-if="shown.categories.length" icon="i-lucide-tag" label="Categories">
          <ul class="flex flex-wrap gap-2">
            <li
              v-for="category in shown.categories"
              :key="category.id"
              class="inline-flex items-center gap-1.5 rounded-full bg-elevated px-2.5 py-1 text-sm"
            >
              <span
                class="size-2.5 shrink-0 rounded-full"
                :style="{ backgroundColor: category.color }"
                aria-hidden="true"
              />
              {{ category.name }}
            </li>
          </ul>
        </EventDetailRow>

        <EventDetailRow v-if="!shown.blocked" icon="i-lucide-circle-check" label="Status">
          <UBadge :label="shown.statusLabel" color="neutral" variant="subtle" size="lg" />
        </EventDetailRow>
      </dl>
    </template>

    <template v-if="shown && !shown.blocked" #footer>
      <div class="flex w-full gap-2 sm:justify-end">
        <UButton
          label="Edit"
          icon="i-lucide-pencil"
          color="neutral"
          variant="outline"
          size="lg"
          class="flex-1 sm:flex-none"
          @click="showNotAvailable"
        />
        <UButton
          label="Delete"
          icon="i-lucide-trash-2"
          color="neutral"
          variant="outline"
          size="lg"
          class="flex-1 text-red-700 sm:flex-none dark:text-red-400"
          @click="showNotAvailable"
        />
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import { resourceIconName } from '~/utils/calendar-icons'
import { buildEventDetails, type EventDetails } from '~/utils/event-display'
import { pickFocusTarget } from '~/utils/focus'
import { makeScrollersFocusable } from '~/utils/scroll-a11y'

const { selectedEvent, selectedEventId, selectEvent, calendarById, categoryById, resourceById } =
  useCalendarState()
const timeZone = useDisplayTimeZone()
const orgTimeZone = useOrgTimeZone()
const isDesktop = useIsDesktop()
const toast = useToast()

const details = computed(() =>
  selectedEvent.value
    ? buildEventDetails(
        selectedEvent.value,
        {
          calendarById: calendarById.value,
          categoryById: categoryById.value,
          resourceById: resourceById.value,
        },
        { display: timeZone.value, org: orgTimeZone.value },
      )
    : null,
)

// Keep showing the last event while the sheet slides out, instead of an empty panel.
const shown = ref<EventDetails | null>(details.value)
watch(details, (value) => {
  if (value) shown.value = value
})

const whenText = computed(() =>
  shown.value ? `${shown.value.when.date}, ${shown.value.when.time}` : undefined,
)

const reducedMotion = ref(false)
let reducedMotionQuery: MediaQueryList | undefined
const updateReducedMotion = (event: MediaQueryListEvent) => {
  reducedMotion.value = event.matches
}

onMounted(() => {
  reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = reducedMotionQuery.matches
  reducedMotionQuery.addEventListener('change', updateReducedMotion)
})

onBeforeUnmount(() => reducedMotionQuery?.removeEventListener('change', updateReducedMotion))

// The sheet has no trigger element, so Reka UI cannot restore focus by itself. Remember the
// element that was active when the event was selected (the clicked entry), synchronously, before
// the sheet moves focus. If FullCalendar re-rendered that entry meanwhile, the calendar container
// (tabindex -1 in CalendarMain) takes the focus instead.
let opener: HTMLElement | null = null

watch(
  selectedEventId,
  (id, previous) => {
    if (id && !previous) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
  },
  { flush: 'sync' },
)

function restoreFocus(event: Event) {
  event.preventDefault()
  pickFocusTarget(opener, document.querySelector<HTMLElement>('[data-calendar-main]'))?.focus()
  opener = null
}

// The body scrolls when the details are taller than a phone sheet: give it a tab stop.
function markScrollers(event: Event) {
  const content = event.target
  if (content instanceof HTMLElement) requestAnimationFrame(() => makeScrollersFocusable(content))
}

function onOpenChange(open: boolean) {
  if (!open) selectEvent(null)
}

function showNotAvailable() {
  toast.add({
    title: 'Editing arrives with the real calendar service',
    description: 'Events are read-only in this preview.',
    icon: 'i-lucide-info',
    color: 'neutral',
  })
}
</script>
