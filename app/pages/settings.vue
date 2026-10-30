<!--
  Settings: the account, the app tokens for calendar apps (FR-31) and the iCal subscriptions
  (FR-7). The layout provides the `<main>` that scrolls, so this page is a plain column inside
  it. `/api/me` is loaded here once; the account section shows it and the token section needs the
  user name from it. Each section loads and reports its own data, so one failing call leaves the
  rest of the page working.
-->
<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4 sm:p-6">
    <header class="flex flex-col gap-1">
      <NuxtLink to="/" class="inline-flex min-h-11 items-center gap-1.5 self-start underline">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        Back to calendar
      </NuxtLink>
      <h1 class="text-2xl font-semibold">Settings</h1>
    </header>

    <UAlert
      v-if="isDemo"
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      title="Demo mode"
      description="Nothing is saved in demo mode. Changes you make here are not kept."
    />

    <SettingsAccountSection :me="me.data.value" :error="me.error.value" @retry="me.reload()" />
    <SettingsTokensSection :username="me.data.value?.username ?? null" />
    <SettingsSubscriptionsSection />
  </div>
</template>

<script setup lang="ts">
import { useAuthFetch } from '~/composables/useAuthFetch'
import { createResource } from '~/utils/settings/resource'
import type { MeResponse } from '~/utils/settings/types'

useHead({ title: 'Settings' })

const api = useAuthFetch()
const config = useServerConfigState()
const isDemo = computed(() => config.value?.demo === true)

const me = createResource(() => api<MeResponse>('/api/me'), 'load your account')
onMounted(() => me.reload())
</script>
