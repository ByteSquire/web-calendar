<!--
  The page the identity provider sends the browser back to after the login (FR-12). It finishes the
  code exchange, then continues to the page the user asked for. It has no layout: the layout shows
  the app's data, which needs the session this page is still creating.
-->
<template>
  <main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold">
      {{ failure ? failure.title : t('Signing in…') }}
    </h1>
    <template v-if="failure">
      <UAlert
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :description="failure.message"
      />
      <p v-if="failure.detail" class="text-muted text-xs break-words">
        {{ t('Details: {detail}', { detail: failure.detail }) }}
      </p>
      <div>
        <UButton :loading="retrying" @click="retry">{{ t('Try again') }}</UButton>
      </div>
    </template>
    <p v-else role="status" class="text-muted">
      {{ t('Finishing the sign-in. This takes a moment.') }}
    </p>
  </main>
</template>

<script setup lang="ts">
import { useAuth } from '~/composables/useAuth'
import { describeAuthError, type AuthFailure } from '~/utils/auth/errors'
import { t } from '~/utils/i18n'
import { looksLikeAuthResponse } from '~/utils/auth/state'

definePageMeta({ layout: false })
useHead({ title: () => t('Signing in') })

const auth = useAuth()
const failure = ref<AuthFailure | null>(null)
const retrying = ref(false)
const heading = useTemplateRef<HTMLElement>('heading')

async function show(error: unknown) {
  failure.value = describeAuthError(error)
  // Screen readers announce the new heading and the alert; keyboard users start at the top.
  await nextTick()
  heading.value?.focus()
}

onMounted(async () => {
  heading.value?.focus()
  const url = window.location.href
  // Opened by hand while signed in (a bookmark, the history): nothing to finish.
  if (!looksLikeAuthResponse(url) && auth.status.value === 'authenticated') {
    await navigateTo('/', { replace: true })
    return
  }
  try {
    const returnTo = await auth.completeLogin(url)
    await navigateTo(returnTo, { replace: true })
  } catch (error) {
    await show(error)
  }
})

async function retry() {
  retrying.value = true
  try {
    await auth.login('/')
  } catch (error) {
    await show(error)
  } finally {
    retrying.value = false
  }
}
</script>
