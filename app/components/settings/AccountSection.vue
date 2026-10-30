<!--
  Account (FR-13): who the server thinks is signed in, and which time zones the screens use
  (FR-29). The data comes from the page (`/api/me` is loaded once and shared with the token
  section, which needs the user name).
-->
<template>
  <section aria-labelledby="settings-account" class="flex flex-col gap-4">
    <h2 id="settings-account" class="text-lg font-semibold">Account</h2>

    <SettingsErrorAlert v-if="error" :message="error" retryable @retry="emit('retry')" />

    <dl v-if="me" class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
      <dt class="text-toned">Name</dt>
      <dd class="flex flex-wrap items-center gap-2 wrap-anywhere">
        <span>{{ me.name ?? NOT_SET }}</span>
        <UBadge
          v-if="me.isAdmin"
          label="Administrator"
          icon="i-lucide-shield-check"
          color="neutral"
          variant="outline"
        />
      </dd>
      <dt class="text-toned">Email</dt>
      <dd class="break-all">{{ me.email ?? NOT_SET }}</dd>
      <dt class="text-toned">User name</dt>
      <dd class="break-all">{{ me.username ?? NOT_SET }}</dd>
    </dl>
    <!-- Same rows as the list, so nothing moves when the data arrives. -->
    <div v-else-if="!error" class="flex flex-col gap-2" role="status">
      <span class="sr-only">Loading account details</span>
      <USkeleton v-for="row in 3" :key="row" class="h-6 w-full max-w-sm" aria-hidden="true" />
    </div>

    <p>
      Times are shown in <strong>{{ displayZone }}</strong> (your browser's zone). Organization time
      zone: <strong>{{ orgZone }}</strong
      >.
    </p>
  </section>
</template>

<script setup lang="ts">
import type { MeResponse } from '~/utils/settings/types'

defineProps<{
  me: MeResponse | null
  /** Why `/api/me` failed, worded for people. */
  error: string | null
}>()
const emit = defineEmits<{ retry: [] }>()

const NOT_SET = 'Not set'
const displayZone = useDisplayTimeZone()
const orgZone = useOrgTimeZone()
</script>
