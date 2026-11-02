<!--
  Edit and delete of an existing event (FR-9), as a sequence of dialogs on top of the event sheet:
  for a repeating event first "which events?", then the edit form or the delete confirmation; the
  writing is done by useEventWrites(). The sheet calls `startEdit(event)` / `startDelete(event)`
  and hears `done` when the event is changed or gone, which closes the sheet.

  The event is copied when the flow starts: the calendar state may reload while the form is open,
  and the form must not change under the person's hands. Focus: the whole flow returns to the
  element that started it (the Edit or Delete button); when it ends in a change the sheet closes
  too and takes the focus back to the calendar itself, so the dialogs leave it alone then.
-->
<template>
  <RecurrenceScopeDialog
    :open="step === 'scope'"
    :action="flow"
    :event-title="event?.title ?? ''"
    :return-focus-to="returnFocusTo"
    @update:open="onScopeOpen"
    @choose="onScopeChosen"
  />
  <EventEditModal
    :open="step === 'final' && flow === 'edit'"
    :event="event"
    :scope="scope"
    :calendar="calendar"
    :category-names="categoryNames"
    :pending="pending"
    :error="error"
    :return-focus-to="returnFocusTo"
    @update:open="onFinalOpen"
    @submit="onEditSubmit"
  />
  <ConfirmDeleteDialog
    :open="step === 'final' && flow === 'delete'"
    :event-title="event?.title ?? ''"
    :detail="deleteDetail"
    :pending="pending"
    :error="error"
    :return-focus-to="returnFocusTo"
    @update:open="onFinalOpen"
    @confirm="onConfirmDelete"
  />
</template>

<script setup lang="ts">
import type { CalendarEvent } from '../../shared/types/calendar'
import { N_, t, tv } from '~/utils/i18n'
import type { EventChanges } from '~/utils/ical/write-types'
import type { ReadEvent } from '~/utils/ical/x-properties'
import { slotOf } from '~/utils/resources/slot'
import type { BookableResource } from '~/utils/resources/types'
import { eventTargetOf, eventWriteAccess } from '~/utils/writes/rules'
import { SUCCESS_TITLES } from '~/utils/writes/messages'
import type { EventTarget, ScopeChoice } from '~/utils/writes/types'

const emit = defineEmits<{
  /** The event was changed or deleted (the sheet that shows it should close). */
  done: []
}>()

const { calendarById, categories } = useCalendarState()
const { edit, remove } = useEventWrites()
const { book } = useResourceBooking()
const timeZone = useDisplayTimeZone()
const toast = useToast()

type Step = 'idle' | 'scope' | 'final'
const step = ref<Step>('idle')
const flow = ref<'edit' | 'delete'>('edit')
const event = ref<CalendarEvent | null>(null)
const target = ref<EventTarget | null>(null)
const scope = ref<ScopeChoice | null>(null)
const pending = ref(false)
const error = ref('')
/** The element that started the flow; `false` once a change ended it (the sheet restores focus). */
const returnFocusTo = ref<HTMLElement | false | null>(null)
// Counts the flows: an answer that arrives after the person left must not touch a later flow.
let flowId = 0

const calendar = computed(() =>
  event.value ? (calendarById.value.get(event.value.calendarId) ?? null) : null,
)
const categoryNames = computed(() => categories.value.map((category) => category.name))

const DELETE_DETAILS: Record<ScopeChoice, string> = {
  this: N_('Only this event is deleted; the rest of the series stays.'),
  following: N_('This event and all the events after it are deleted.'),
  all: N_('The whole series is deleted.'),
}
const deleteDetail = computed(() =>
  scope.value ? tv(DELETE_DETAILS[scope.value]) : t('The event is removed from the calendar.'),
)

const hasMarks = (chosen: CalendarEvent) => (chosen as ReadEvent).bookingMarks !== undefined

function begin(kind: 'edit' | 'delete', chosen: CalendarEvent) {
  const found = eventTargetOf(chosen, calendarById.value)
  if (!found) {
    const access = eventWriteAccess(chosen, calendarById.value)
    toast.add({
      title: t("This event can't be changed"),
      description: access.allowed ? undefined : access.reason,
      icon: 'i-lucide-info',
      color: 'neutral',
    })
    return
  }
  flowId += 1
  flow.value = kind
  event.value = { ...chosen }
  target.value = found
  scope.value = null
  error.value = ''
  pending.value = false
  returnFocusTo.value =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  step.value = found.recurring ? 'scope' : 'final'
}

function finish(restoreFocus: boolean) {
  if (!restoreFocus) returnFocusTo.value = false
  step.value = 'idle'
}

function onScopeOpen(open: boolean) {
  if (!open && step.value === 'scope') finish(true)
}

function onScopeChosen(choice: ScopeChoice) {
  scope.value = choice
  step.value = 'final'
}

function onFinalOpen(open: boolean) {
  if (!open && step.value === 'final') finish(true)
}

function failureToast(title: string, message: string) {
  toast.add({ title, description: message, icon: 'i-lucide-triangle-alert', color: 'error' })
}

/** Books the resources chosen in the edit form for the saved event; the event stays saved. */
async function bookFor(
  chosen: EventTarget & { uid: string; marked: boolean },
  ev: CalendarEvent,
  changes: EventChanges,
  resources: BookableResource[],
) {
  const when = changes.when ?? { start: ev.start, end: ev.end, allDay: ev.allDay }
  const report = await book({
    resources,
    slot: slotOf(when, timeZone.value),
    eventUid: chosen.uid,
    // The marks name one resource for the whole series: not for one occurrence, and not over the
    // marks of a resource the event already books.
    markUrl: ev.recurring || chosen.marked ? null : chosen.href,
    calendarHref: chosen.calendarHref,
  })
  const failures = [...report.failures]
  if (report.result.marksFailed) {
    failures.push(t('The booking was made, but the event could not be marked with it.'))
  }
  return { failures, summary: report.booked ?? '', anyBooked: report.result.booked.length > 0 }
}

async function onEditSubmit(changes: EventChanges, resources: BookableResource[] = []) {
  if (pending.value || !target.value || !event.value) return
  const mine = flowId
  const title = event.value.title
  pending.value = true
  error.value = ''
  try {
    const outcome = await edit({ target: target.value, scope: scope.value, changes })
    // False when the person closed the form while the request was running.
    const open = mine === flowId && step.value !== 'idle'
    if (!outcome.ok) {
      if (open && !outcome.failure.closeForm) {
        error.value = outcome.failure.message
        return
      }
      if (open) finish(true)
      failureToast(t('The event could not be saved'), outcome.failure.message)
      return
    }
    const booking =
      resources.length > 0
        ? await bookFor(
            { ...target.value, uid: event.value.uid, marked: hasMarks(event.value) },
            event.value,
            changes,
            resources,
          )
        : null
    if (booking && booking.failures.length > 0) {
      // Nothing changed in the event itself and nothing was booked: the form can try again.
      if (open && outcome.unchanged && !booking.anyBooked) {
        error.value = t('Nothing was booked. {reasons}', { reasons: booking.failures.join(' ') })
        return
      }
      if (open) {
        finish(false)
        emit('done')
      }
      failureToast(
        t('The event was saved, but not everything was booked'),
        booking.failures.join(' '),
      )
      return
    }
    if (outcome.unchanged && !booking) {
      if (open) finish(true)
      toast.add({ title: tv(SUCCESS_TITLES.unchanged), icon: 'i-lucide-info', color: 'neutral' })
      return
    }
    if (open) {
      finish(false)
      emit('done')
    }
    toast.add({
      title: tv(SUCCESS_TITLES.updated),
      description: [title, booking?.summary].filter(Boolean).join('. '),
      icon: 'i-lucide-check',
    })
  } finally {
    if (mine === flowId) pending.value = false
  }
}

const DELETED_TEXT: Record<ScopeChoice, (title: string) => string> = {
  this: (title) => t('"{title}" was deleted.', { title }),
  following: (title) => t('"{title}" and the events after it were deleted.', { title }),
  all: (title) => t('All events of "{title}" were deleted.', { title }),
}

async function onConfirmDelete() {
  if (pending.value || !target.value || !event.value) return
  const mine = flowId
  const title = event.value.title
  const chosen = scope.value
  pending.value = true
  error.value = ''
  try {
    const outcome = await remove({ target: target.value, scope: chosen })
    const open = mine === flowId && step.value !== 'idle'
    if (!outcome.ok) {
      if (open && !outcome.failure.closeForm) {
        error.value = outcome.failure.message
        return
      }
      if (open) finish(true)
      failureToast(t('The event could not be deleted'), outcome.failure.message)
      return
    }
    if (open) {
      finish(false)
      emit('done')
    }
    toast.add(
      outcome.alreadyGone
        ? {
            title: tv(SUCCESS_TITLES.alreadyDeleted),
            description: t('The calendar has been reloaded.'),
            icon: 'i-lucide-info',
            color: 'neutral',
          }
        : {
            title: tv(SUCCESS_TITLES.deleted),
            description: DELETED_TEXT[chosen ?? 'this'](title),
            icon: 'i-lucide-check',
          },
    )
  } finally {
    if (mine === flowId) pending.value = false
  }
}

defineExpose({
  startEdit: (chosen: CalendarEvent) => begin('edit', chosen),
  startDelete: (chosen: CalendarEvent) => begin('delete', chosen),
})
</script>
