<!--
  Settings: the account, the time zone (FR-32), the language, the app tokens for calendar apps (FR-31),
  the calendar links (read-only pages of one calendar behind a password, not in demo mode), the
  external CalDAV accounts (FR-8, not in demo mode), the iCal subscriptions and the import of an
  .ics file (FR-7). The layout provides the `<main>` that scrolls, so this page is a plain column
  inside it. `/api/me` is loaded here once; the account and time zone sections show it and the
  token section needs the user name from it. Each section loads and reports its own data, so one
  failing call leaves the rest of the page working.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        {{ t('Back to calendar') }}
      </NuxtLink>
      <h1 class="text-2xl font-semibold">{{ t('Settings') }}</h1>
    </header>

    <UAlert
      v-if="isDemo"
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      :title="t('Demo mode')"
      :description="t('Nothing is saved in demo mode. Changes you make here are not kept.')"
    />

    <SettingsAccountSection :me="me.data.value" :error="me.error.value" @retry="me.reload()" />
    <SettingsTimeZoneSection :me="me.data.value" :error="me.error.value" />
    <SettingsLanguageSection />
    <SettingsTokensSection :username="me.data.value?.username ?? null" />
    <!-- A link reads the calendar on the server as its maker: not in demo mode. -->
    <SettingsCalendarLinksSection v-if="live" />
    <!-- Needs the login and the server (FR-8): not in demo mode, which has no API behind it. -->
    <SettingsExternalAccountsSection v-if="live" />
    <SettingsSubscriptionsSection />
    <SettingsImportSection />
  </div>
</template>

<script setup lang="ts">
import { useAuthFetch } from '~/composables/useAuthFetch'
import { N_, t } from '~/utils/i18n'
import { isLiveConfig } from '~/utils/live/seed'
import { createResource } from '~/utils/settings/resource'
import type { MeResponse } from '~/utils/settings/types'

useHead({ title: () => t('Settings') })

const api = useAuthFetch()
const config = useServerConfigState()
const isDemo = computed(() => config.value?.demo === true)
const live = computed(() => isLiveConfig(config.value))

const me = createResource(() => api<MeResponse>('/api/me'), N_('load your account'))
onMounted(() => me.reload())
</script>
