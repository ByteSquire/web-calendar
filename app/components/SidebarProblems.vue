<!--
  What could not be loaded (NFR-4): one entry per failing calendar or source with a short reason and
  a Retry button. Nothing is rendered while all is well. A problem is announced (role="alert")
  only when it appears; the same list read again later is plain text. The error colour is used
  for the border, tint and icon only; the text keeps the normal colour for contrast in both
  schemes. Rows wrap at narrow widths, so nothing is cut off at 360 px.
-->
<template>
  <section
    v-if="entries.length > 0"
    ref="section"
    :aria-labelledby="headingId"
    class="flex flex-col"
    data-sidebar-problems
  >
    <h2
      :id="headingId"
      class="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase"
    >
      Problems
    </h2>
    <ul class="flex flex-col gap-2">
      <li
        v-for="entry in entries"
        :key="entry.id"
        :role="fresh.has(entry.signature) && entry.retryKey ? 'alert' : undefined"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border p-2 text-sm text-default"
        :class="entry.retryKey ? 'border-error/50 bg-error/10' : 'border-warning/50 bg-warning/10'"
      >
        <UIcon
          :name="entry.retryKey ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'"
          class="size-4 shrink-0"
          :class="entry.retryKey ? 'text-error' : 'text-warning'"
          aria-hidden="true"
        />
        <p class="min-w-0 flex-1 basis-40 break-words">
          <span class="font-semibold">{{ entry.name }}</span>
          <span class="sr-only">: </span>
          <span class="block">{{ entry.message }}</span>
        </p>
        <UButton
          v-if="entry.retryKey"
          size="sm"
          color="neutral"
          variant="outline"
          class="min-h-11 shrink-0"
          :loading="retrying.has(entry.retryKey)"
          :aria-label="`Retry ${entry.name}`"
          @click="retryEntry(entry.retryKey)"
        >
          Retry
        </UButton>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { isSourceKey, SOURCE_LABELS } from '~/utils/live/errors'

interface Entry {
  id: string
  name: string
  message: string
  /** Set for failures, which can be retried; unset for notes. */
  retryKey: string | null
  /** What the announcement is keyed on: the same problem with the same words is not new. */
  signature: string
}

const { errors, skipped, retry } = useLiveStatus()
const { calendarById } = useCalendarState()

const headingId = useId()
const section = ref<HTMLElement | null>(null)

const nameOf = (key: string) =>
  isSourceKey(key) ? SOURCE_LABELS[key] : (calendarById.value.get(key)?.name ?? 'Calendar')

const entries = computed<Entry[]>(() => {
  const failures = Object.entries(errors.value).map(([key, message]) => ({
    id: `error:${key}`,
    name: nameOf(key),
    message,
    retryKey: key,
    signature: `error:${key}:${message}`,
  }))
  // A calendar that failed as a whole needs no second note about its entries.
  const notes = Object.entries(skipped.value)
    .filter(([key]) => !(key in errors.value))
    .map(([key, count]) => ({
      id: `note:${key}`,
      name: nameOf(key),
      message:
        count === 1
          ? '1 entry could not be read and is not shown'
          : `${count} entries could not be read and are not shown`,
      retryKey: null,
      signature: `note:${key}:${count}`,
    }))
  return [...failures, ...notes]
})

// Signatures shown before, kept for the session: a problem that is on screen already (the slideover
// was closed and opened again) is not announced a second time.
const announced = useState<string[]>('live-problems-announced', () => [])
const fresh = computed(
  () => new Set(entries.value.map((e) => e.signature).filter((s) => !announced.value.includes(s))),
)
// After the render that carried role="alert", the entries count as announced.
function markAnnounced() {
  announced.value = entries.value.map((entry) => entry.signature)
}
watch(entries, markAnnounced, { flush: 'post' })
onMounted(markAnnounced)

const retrying = reactive(new Set<string>())

async function retryEntry(key: string) {
  if (retrying.has(key)) return
  retrying.add(key)
  const container = section.value?.closest<HTMLElement>('aside, [role="dialog"]') ?? null
  try {
    await retry(key)
  } finally {
    retrying.delete(key)
  }
  // The entry (and the button that had focus) is gone when the retry worked: keep keyboard users
  // in the sidebar instead of dropping them on the page.
  await nextTick()
  if (!document.activeElement || document.activeElement === document.body) {
    const target = section.value ?? container?.querySelector<HTMLElement>('button, [href], input')
    if (target && target === section.value) target.setAttribute('tabindex', '-1')
    target?.focus()
  }
}
</script>
