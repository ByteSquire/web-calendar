<!--
  The password of an external CalDAV account (FR-8), asked for when this browser has none (a new
  session or device) or the account's server refused it. The dialog only reports what was typed;
  the host sends it and keeps `busy` and `error`. The password is cleared from here the moment it is
  reported and whenever the dialog closes. Focus starts in the password field (the question), goes
  back to what had focus when the dialog opened, or to `fallback` when that is gone, and Escape
  closes it (not while a request is running, which cannot be taken back).
-->
<template>
  <UModal
    :open="open"
    :title="t('Password for “{name}”', { name: accountName })"
    :description="description"
    :content="{ onOpenAutoFocus: focusPassword, onCloseAutoFocus: focusReturn.restore }"
    :ui="{ title: 'wrap-anywhere', description: 'wrap-anywhere' }"
    @update:open="onOpenChange"
  >
    <template #body>
      <form
        id="external-password-form"
        novalidate
        class="flex flex-col gap-4"
        @submit.prevent="onSubmit"
      >
        <SettingsErrorAlert v-if="error" :message="error" />
        <UFormField
          :label="t('Password')"
          name="external-password"
          required
          :error="missing ? t('Enter the password of the account.') : undefined"
          :ui="FIELD_UI"
        >
          <UInput
            ref="passwordInput"
            v-model="password"
            type="password"
            autocomplete="off"
            spellcheck="false"
            class="w-full"
          />
        </UFormField>
        <UCheckbox
          v-model="rememberChoice"
          :label="t('Remember on this device')"
          :description="
            t(
              'What is kept is a sealed credential, not your password. It works only through this app and only for this server. Leave this off on a shared computer.',
            )
          "
        />
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('Cancel')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="onOpenChange(false)"
        />
        <UButton
          type="submit"
          form="external-password-form"
          :label="busy ? t('Saving…') : t('Save password')"
          icon="i-lucide-key-round"
          :aria-busy="busy"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'
import { keepFocusOffControlsOnTouch } from '~/utils/focus'
import { createFocusReturn } from '~/utils/settings/focus-return'
import { FIELD_UI } from '~/utils/settings/ui'

const props = defineProps<{
  open: boolean
  accountName: string
  /** The user name the password is for; none for an account without one. */
  username?: string | null
  busy: boolean
  /** Why the last attempt failed; shown inside the dialog. */
  error: string | null
  /** Whether "Remember on this device" starts checked (it was on for this account before). */
  remember?: boolean
  /** Where focus goes when the element that opened the dialog is gone. */
  fallback?: HTMLElement | null
}>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [value: { password: string; remember: boolean }]
}>()

const description = computed(() =>
  props.username
    ? t('Enter the password of {username}. It is sent to your calendar server through this app.', {
        username: props.username,
      })
    : t('Enter the password of the account. It is sent to your calendar server through this app.'),
)

const password = ref('')
const rememberChoice = ref(props.remember ?? false)
const missing = ref(false)
const passwordInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('passwordInput')
const focusReturn = createFocusReturn(() => props.fallback)

watch(
  () => props.open,
  (open) => {
    if (open) {
      focusReturn.remember()
      rememberChoice.value = props.remember ?? false
    }
    // Nothing typed stays in the page after the dialog is gone.
    clearPassword()
    missing.value = false
  },
)

// The message is about the empty field; typing answers it.
watch(password, (value) => {
  if (value !== '') missing.value = false
})

function onOpenChange(open: boolean) {
  if (!open && props.busy) return
  emit('update:open', open)
}

function focusPassword(event: Event) {
  if (keepFocusOffControlsOnTouch(event)) return
  event.preventDefault()
  passwordInput.value?.inputRef?.focus()
}

function onSubmit() {
  if (props.busy) return
  missing.value = password.value === ''
  if (missing.value) {
    passwordInput.value?.inputRef?.focus()
    return
  }
  const value = { password: password.value, remember: rememberChoice.value }
  clearPassword()
  emit('submit', value)
  // After a refused attempt the field is empty again: the person types the corrected password.
  passwordInput.value?.inputRef?.focus()
}

/** Empties the field itself too, not only the model: no re-render has to happen for it to go. */
function clearPassword() {
  password.value = ''
  if (passwordInput.value?.inputRef) passwordInput.value.inputRef.value = ''
}
</script>
