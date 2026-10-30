<!--
  Where logout ends when the identity provider has no end-session endpoint (Kanidm has none): the
  app's tokens are gone, but the provider's own session is not, so opening the app again would sign
  the user straight back in. This page waits for the user to ask for that.
-->
<template>
  <main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold">You are signed out</h1>
    <p class="text-muted">
      You have signed out of Web Calendar in this browser tab. Your sign-in provider may still
      remember you, so signing in again may not ask for your password.
    </p>
    <UAlert
      v-if="problem"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="problem"
    />
    <div>
      <UButton :loading="busy" @click="signIn">Sign in again</UButton>
    </div>
  </main>
</template>

<script setup lang="ts">
import { useAuth } from '~/composables/useAuth'
import { describeAuthError } from '~/utils/auth/errors'

definePageMeta({ layout: false })
useHead({ title: 'Signed out' })

const auth = useAuth()
const busy = ref(false)
const problem = ref<string | null>(null)
const heading = useTemplateRef<HTMLElement>('heading')

onMounted(() => heading.value?.focus())

async function signIn() {
  busy.value = true
  problem.value = null
  try {
    await auth.login('/')
  } catch (error) {
    problem.value = describeAuthError(error).message
  } finally {
    busy.value = false
  }
}
</script>
