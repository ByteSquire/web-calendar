<!--
  Resource bookings (FR-19). Managers see the pending requests of the resources they manage and
  accept or decline them: an overlapping pending request is only a hint until one is approved,
  which declines the others. Everybody sees their own bookings and can cancel them. A person who
  manages nothing and has no booking is sent back to the calendar; that is only tidiness, the
  routes check the rights themselves. Demo mode keeps the rows in local state.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        Back to calendar
      </NuxtLink>
      <h1 class="text-2xl font-semibold">Resource bookings</h1>
    </header>

    <div v-if="!bookings.loaded.value && !bookings.error.value" role="status" class="flex">
      <span class="sr-only">Loading the bookings</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <template v-if="bookings.error.value">
      <FormAlert :message="bookings.error.value" />
      <UButton
        label="Try again"
        color="neutral"
        variant="outline"
        class="min-h-11 self-start"
        @click="start()"
      />
    </template>

    <template v-if="bookings.loaded.value">
      <section
        v-if="bookings.manages.value"
        aria-labelledby="requests-heading"
        class="flex flex-col gap-3"
      >
        <h2 id="requests-heading" class="text-lg font-semibold">Pending requests</h2>
        <p v-if="bookings.requests.value.length === 0" data-requests-none class="text-toned">
          There are no pending requests.
        </p>
        <ul v-else class="flex flex-col gap-3">
          <li
            v-for="row in bookings.requests.value"
            :key="row.id"
            data-request
            class="flex flex-col gap-2 rounded-lg border border-default p-3"
          >
            <div>
              <p class="font-medium">{{ row.resourceName }}</p>
              <p>{{ slotText(row) }}</p>
              <p class="text-toned">Requested by {{ row.requesterName }}</p>
            </div>
            <p v-if="row.orphaned" data-orphaned class="flex items-start gap-1.5 text-sm">
              <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
              <span>
                The event of this booking cannot be found right now. It may have been moved or
                deleted; check before you approve.
              </span>
            </p>
            <p
              v-if="row.overlapIds.length > 0"
              data-overlap
              class="flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-200"
            >
              <UIcon name="i-lucide-layers" class="mt-0.5 size-4 shrink-0" />
              <span>{{ overlapText(row) }}</span>
            </p>
            <div class="flex flex-wrap gap-2">
              <UButton
                label="Accept"
                icon="i-lucide-check"
                class="min-h-11"
                :aria-label="`Accept ${row.requesterName}'s request for ${row.resourceName}, ${slotText(row)}`"
                :disabled="busy"
                @click="decide(row, 'accept')"
              />
              <UButton
                label="Decline"
                icon="i-lucide-x"
                color="neutral"
                variant="outline"
                class="min-h-11"
                :aria-label="`Decline ${row.requesterName}'s request for ${row.resourceName}, ${slotText(row)}`"
                :disabled="busy"
                @click="decide(row, 'decline')"
              />
            </div>
          </li>
        </ul>
      </section>

      <section aria-labelledby="mine-heading" class="flex flex-col gap-3">
        <h2 id="mine-heading" class="text-lg font-semibold">My bookings</h2>
        <p v-if="bookings.mine.value.length === 0" data-mine-none class="text-toned">
          You have no upcoming bookings.
        </p>
        <ul v-else class="flex flex-col gap-3">
          <li
            v-for="row in bookings.mine.value"
            :key="row.id"
            data-mine
            class="flex flex-col gap-2 rounded-lg border border-default p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p class="font-medium">{{ row.resourceName }}</p>
              <p>{{ slotText(row) }}</p>
              <p class="text-toned">
                {{ row.status === 'pending' ? 'Waiting for approval' : 'Approved' }}
              </p>
            </div>
            <UButton
              label="Cancel booking"
              icon="i-lucide-trash-2"
              color="neutral"
              variant="outline"
              class="min-h-11 self-start"
              :aria-label="`Cancel booking of ${row.resourceName}, ${slotText(row)}`"
              :disabled="busy"
              @click="decide(row, 'cancel')"
            />
          </li>
        </ul>
      </section>
    </template>

    <p role="status" aria-live="polite" data-bookings-notice class="min-h-5 text-sm">
      {{ notice }}
    </p>
    <FormAlert :message="problem" />
  </div>
</template>

<script setup lang="ts">
import { useResourceBookings } from '~/composables/useResourceBookings'
import { formatSlot } from '~/utils/resources/format'
import type { BookingRow } from '~/utils/resources/rows'

useHead({ title: 'Resource bookings' })

const router = useRouter()
const zone = useDisplayTimeZone()
const bookings = useResourceBookings()
const busy = ref(false)
const notice = ref('')
const problem = ref('')

const slotText = (row: BookingRow) => formatSlot(row.start, row.end, zone.value)

function overlapText(row: BookingRow): string {
  const others = bookings.requests.value.filter((other) => row.overlapIds.includes(other.id))
  const names = others.map((other) => `${other.requesterName} (${slotText(other)})`)
  const lead =
    row.overlapIds.length === 1
      ? 'Overlaps another pending request'
      : `Overlaps ${row.overlapIds.length} other pending requests`
  return names.length > 0
    ? `${lead}: ${names.join(', ')}. Approving this one declines the others.`
    : `${lead}. Approving this one declines the others.`
}

async function start() {
  await bookings.load()
  if (bookings.loaded.value && !bookings.manages.value && bookings.mine.value.length === 0) {
    await router.replace('/')
  }
}

onMounted(start)

async function decide(row: BookingRow, action: 'accept' | 'decline' | 'cancel') {
  if (busy.value) return
  busy.value = true
  notice.value = ''
  problem.value = ''
  const result = await bookings[action](row)
  busy.value = false
  if (result.ok) notice.value = result.message
  else problem.value = result.message
}
</script>
