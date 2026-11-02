<!--
  Account (FR-13): who the server thinks is signed in, and which time zones the screens use
  (FR-29). The data comes from the page (`/api/me` is loaded once and shared with the token
  section, which needs the user name).
-->
<template>
  <section aria-labelledby="settings-account" class="flex flex-col gap-4">
    <h2 id="settings-account" class="text-lg font-semibold">{{ t('Account') }}</h2>

    <SettingsErrorAlert v-if="error" :message="error" retryable @retry="emit('retry')" />

    <dl v-if="me" class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
      <dt class="text-toned">{{ t('Name') }}</dt>
      <dd class="flex flex-wrap items-center gap-2 wrap-anywhere">
        <span>{{ me.name ?? tv(NOT_SET) }}</span>
        <UBadge
          v-if="me.isAdmin"
          :label="t('Administrator')"
          icon="i-lucide-shield-check"
          color="neutral"
          variant="outline"
        />
      </dd>
      <dt class="text-toned">{{ t('Email') }}</dt>
      <dd class="break-all">{{ me.email ?? tv(NOT_SET) }}</dd>
      <dt class="text-toned">{{ t('User name') }}</dt>
      <dd class="break-all">{{ me.username ?? tv(NOT_SET) }}</dd>
    </dl>
    <!-- Same rows as the list, so nothing moves when the data arrives. -->
    <div v-else-if="!error" class="flex flex-col gap-2" role="status">
      <span class="sr-only">{{ t('Loading account details') }}</span>
      <USkeleton v-for="row in 3" :key="row" class="h-6 w-full max-w-sm" aria-hidden="true" />
    </div>

    <p>
      <template
        v-for="(part, i) in tparts(
          'Times are shown in {displayZone} ({source}). Organization time zone: {orgZone}.',
        )"
        :key="i"
      >
        <strong v-if="'name' in part && part.name === 'displayZone'">{{ displayZone }}</strong>
        <template v-else-if="'name' in part && part.name === 'source'">{{ zoneSource }}</template>
        <strong v-else-if="'name' in part">{{ orgZone }}</strong>
        <template v-else>{{ part.text }}</template>
      </template>
    </p>
  </section>
</template>

<script setup lang="ts">
import { N_, t, tparts, tv } from '~/utils/i18n'
import type { MeResponse } from '~/utils/settings/types'

defineProps<{
  me: MeResponse | null
  /** Why `/api/me` failed, worded for people. */
  error: string | null
}>()
const emit = defineEmits<{ retry: [] }>()

const NOT_SET = N_('Not set')
const displayZone = useDisplayTimeZone()
const orgZone = useOrgTimeZone()
const userZone = useUserTimeZone()
// What decided the display zone: the user's own choice (FR-32), else the browser.
const zoneSource = computed(() =>
  userZone.value === displayZone.value ? t('your setting') : t("your browser's zone"),
)
</script>
