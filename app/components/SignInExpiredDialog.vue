<!--
  "Your sign-in has expired", over the app, when the sign-in ran out while the app was open: the
  token could not be renewed (the provider ended the session, or gave no refresh token; design §6).
  The app stays on screen, so nothing the person has not saved is thrown away by surprise.
  "Sign in again" goes to the sign-in provider and back to this page (what is not saved is lost
  then); "Not now" closes the dialog so they can copy what they typed, and the next request that
  needs the server asks again. A sign-out never comes here: it hides the app. Live mode only.
-->
<template>
  <UModal
    :open="open"
    :title="t('Your sign-in has expired')"
    :description="
      t(
        'Sign in again to go on. Anything you have not saved yet is lost when you do: choose “Not now” to copy it first.',
      )
    "
    :dismissible="!busy"
    :content="{ onCloseAutoFocus: restoreFocus }"
    @update:open="(value) => (value ? undefined : dismiss())"
  >
    <template #body>
      <FormAlert :message="problem" />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('Not now')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="dismiss"
        />
        <UButton
          :label="t('Sign in again')"
          icon="i-lucide-log-in"
          :loading="busy"
          @click="signIn"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { useAuth } from '~/composables/useAuth'
import { describeAuthError } from '~/utils/auth/errors'
import { t } from '~/utils/i18n'

const auth = useAuth()
const route = useRoute()
const open = ref(false)
const busy = ref(false)
const problem = ref('')
// The dialog opens without a trigger (a request found the session gone): focus goes back to what
// had it, such as the field of an event the person was editing.
let opener: HTMLElement | null = null

// Opens when the sign-in expires and again at each later request that needs it; closes when the
// status leaves `expired` (signing out hides the app anyway).
watch(
  [auth.status, auth.expiredSignal],
  ([status]) => {
    const expired = status === 'expired'
    if (expired && !open.value) {
      opener = document.activeElement as HTMLElement | null
      problem.value = ''
    }
    open.value = expired
  },
  { immediate: true },
)
useBackDismiss(open, dismiss)

function dismiss() {
  if (!busy.value) open.value = false
}

function restoreFocus(event: Event) {
  event.preventDefault()
  if (opener?.isConnected) opener.focus()
}

async function signIn() {
  busy.value = true
  problem.value = ''
  try {
    // The browser leaves for the provider; this settles only if the page stays (or fails).
    await auth.login(route.fullPath)
  } catch (cause) {
    problem.value = describeAuthError(cause).message
  } finally {
    busy.value = false
  }
}
</script>
