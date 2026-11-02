<!--
  Resource bookings (FR-19). Managers see the pending requests of the resources they manage and
  accept or decline them: an overlapping pending request is only a hint until one is approved,
  which declines the others. Everybody sees their own bookings and can cancel them. Nobody is sent
  away: the sidebar links this page for everybody, and a person with nothing to decide and no
  booking sees that, instead of being thrown back to the calendar. The routes check the rights
  themselves. Demo mode keeps the rows in local state.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to calendar') }}
      </NuxtLink>
      <h1 class="text-2xl font-semibold">{{ t('Resource bookings') }}</h1>
    </header>

    <div v-if="!bookings.loaded.value && !bookings.error.value" role="status" class="flex">
      <span class="sr-only">{{ t('Loading the bookings') }}</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <template v-if="bookings.error.value">
      <FormAlert :message="bookings.error.value" />
      <UButton
        :label="t('Try again')"
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
        <h2 id="requests-heading" class="text-lg font-semibold">{{ t('Pending requests') }}</h2>
        <p v-if="bookings.requests.value.length === 0" data-requests-none class="text-toned">
          {{ t('There are no pending requests.') }}
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
              <p class="text-toned">
                {{ t('Requested by {name}', { name: row.requesterName }) }}
              </p>
            </div>
            <p v-if="row.orphaned" data-orphaned class="flex items-start gap-1.5 text-sm">
              <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
              <span>
                {{
                  t(
                    'The event of this booking cannot be found right now. It may have been moved or deleted; check before you approve.',
                  )
                }}
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
                :label="t('Accept')"
                icon="i-lucide-check"
                class="min-h-11"
                :aria-label="acceptLabel(row)"
                :disabled="busy"
                @click="decide(row, 'accept')"
              />
              <UButton
                :label="t('Decline')"
                icon="i-lucide-x"
                color="neutral"
                variant="outline"
                class="min-h-11"
                :aria-label="declineLabel(row)"
                :disabled="busy"
                @click="decide(row, 'decline')"
              />
            </div>
          </li>
        </ul>
      </section>

      <section aria-labelledby="mine-heading" class="flex flex-col gap-3">
        <h2 id="mine-heading" class="text-lg font-semibold">{{ t('My bookings') }}</h2>
        <p v-if="bookings.mine.value.length === 0" data-mine-none class="text-toned">
          {{ t('You have no upcoming bookings.') }}
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
                {{ row.status === 'pending' ? t('Waiting for approval') : t('Approved') }}
              </p>
            </div>
            <UButton
              :label="t('Cancel booking')"
              icon="i-lucide-trash-2"
              color="neutral"
              variant="outline"
              class="min-h-11 self-start"
              :aria-label="
                t('Cancel booking of {resource}, {slot}', {
                  resource: row.resourceName,
                  slot: slotText(row),
                })
              "
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
import { t, tc } from '~/utils/i18n'
import { formatSlot } from '~/utils/resources/format'
import type { BookingRow } from '~/utils/resources/rows'

useHead({ title: () => t('Resource bookings') })

const zone = useDisplayTimeZone()
const bookings = useResourceBookings()
const busy = ref(false)
const notice = ref('')
const problem = ref('')

const slotText = (row: BookingRow) => formatSlot(row.start, row.end, zone.value)

function overlapText(row: BookingRow): string {
  const others = bookings.requests.value.filter((other) => row.overlapIds.includes(other.id))
  const names = others.map((other) => `${other.requesterName} (${slotText(other)})`)
  const lead = tc(
    'Overlaps another pending request | Overlaps {count} other pending requests',
    row.overlapIds.length,
  )
  return names.length > 0
    ? t('{lead}: {names}. Approving this one declines the others.', {
        lead,
        names: names.join(', '),
      })
    : t('{lead}. Approving this one declines the others.', { lead })
}

const acceptLabel = (row: BookingRow) =>
  t("Accept {requester}'s request for {resource}, {slot}", {
    requester: row.requesterName,
    resource: row.resourceName,
    slot: slotText(row),
  })

const declineLabel = (row: BookingRow) =>
  t("Decline {requester}'s request for {resource}, {slot}", {
    requester: row.requesterName,
    resource: row.resourceName,
    slot: slotText(row),
  })

const start = () => bookings.load()

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
