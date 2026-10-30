<!--
  The form of an external CalDAV account (FR-8), for adding and for changing one. It checks the
  input itself first (utils/external/validation.ts) and shows what the server rejected next to the
  input it is about; a server message disappears as soon as that input is edited, because the
  message is about the value that was sent. The password never stays in the form: it is cleared the
  moment it is reported. The parent does the request.
-->
<template>
  <form novalidate class="flex flex-col gap-4" @submit.prevent="onSubmit">
    <UFormField label="Name" name="name" required :error="shownErrors.name" :ui="FIELD_UI">
      <UInput ref="nameInput" v-model="name" autocomplete="off" class="w-full" />
    </UFormField>

    <UFormField
      label="Address of the CalDAV server"
      name="url"
      required
      help="A calendar, a folder of calendars or the account's start address, for example https://dav.example.org/."
      :error="shownErrors.url"
      :ui="FIELD_UI"
    >
      <UInput
        ref="urlInput"
        v-model="url"
        type="url"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        class="w-full"
      />
    </UFormField>

    <div ref="loginGroup" class="flex flex-col gap-2">
      <URadioGroup
        v-model="authMode"
        legend="Login"
        :items="authItems"
        :ui="RADIO_UI"
        :aria-describedby="loginsEnabled ? undefined : 'external-logins-disabled'"
      />
      <!-- Also where a refusal of the choice shows: the server can turn logins off while the form is open. -->
      <p
        v-if="!loginsEnabled"
        id="external-logins-disabled"
        class="text-sm"
        :class="shownErrors.authMode ? ERROR_TEXT : 'text-toned'"
      >
        The administrator has not enabled logins for external accounts, so only accounts without a
        login can be added.
      </p>
    </div>

    <template v-if="authMode === 'basic'">
      <UFormField
        label="User name"
        name="username"
        required
        :error="shownErrors.username"
        :ui="FIELD_UI"
      >
        <UInput
          ref="usernameInput"
          v-model="username"
          autocomplete="off"
          spellcheck="false"
          class="w-full"
        />
      </UFormField>

      <UFormField
        label="Password"
        name="password"
        :required="mustEnterPassword"
        :help="
          mustEnterPassword
            ? 'It is sent to this app’s server once, which seals it. Only the seal is kept.'
            : 'Leave it empty to keep the password you entered before.'
        "
        :error="shownErrors.password"
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
        v-model="remember"
        label="Remember on this device"
        description="What is kept is a sealed credential, not your password. It works only through this app and only for this server. Leave this off on a shared computer."
      />
    </template>

    <SettingsColorPicker v-model="color" :choices="choices" />

    <div class="flex flex-wrap justify-end gap-2">
      <UButton
        v-if="cancelable"
        label="Cancel"
        color="neutral"
        variant="outline"
        :disabled="busy"
        @click="emit('cancel')"
      />
      <UButton type="submit" :label="busy ? 'Saving…' : submitLabel" :aria-busy="busy" />
    </div>
  </form>
</template>

<script setup lang="ts">
import type { ExternalAccount } from '../../../shared/types/external'
import type { ExternalFormInput } from '~/utils/external/form'
import { passwordRequired, validateExternalForm } from '~/utils/external/validation'
import { colorChoices } from '~/utils/settings/palette'
import { ERROR_TEXT, FIELD_UI } from '~/utils/settings/ui'

const props = defineProps<{
  /** The account being changed; none when adding. */
  account?: ExternalAccount
  submitLabel: string
  busy: boolean
  cancelable?: boolean
  /** False when the server cannot seal passwords: only accounts without a login are possible. */
  loginsEnabled: boolean
  /** "Remember on this device" starts checked (it was on for this account before). */
  remembered?: boolean
  /** Field messages from the server (`name`, `url`, `username`, `password`). */
  serverErrors?: Record<string, string>
}>()
const emit = defineEmits<{ submit: [input: ExternalFormInput]; cancel: [] }>()

// A row is a 44 px target in full: the radio's pseudo-element spreads over the whole row.
const RADIO_UI = {
  item: 'relative min-h-11 items-center',
  base: 'before:absolute before:inset-0',
  fieldset: 'gap-1',
}

// An account that has a login keeps it when logins are switched off meanwhile: the form must not
// refuse its other changes (the server decides what it still accepts).
const loginsAllowed = computed(() => props.loginsEnabled || props.account?.authMode === 'basic')

const authItems = computed(() => [
  { label: 'No login', value: 'none' },
  {
    label: 'User name and password',
    value: 'basic',
    disabled: !loginsAllowed.value,
  },
])

// "Default" is the colour the server gives each calendar.
const choices = computed(() => colorChoices(props.account?.color ?? '', true))

const name = ref(props.account?.name ?? '')
const url = ref(props.account?.url ?? '')
const authMode = ref<'none' | 'basic'>(props.account?.authMode ?? 'none')
const username = ref(props.account?.username ?? '')
const password = ref('')
const remember = ref(props.remembered ?? false)
const color = ref(props.account?.color?.toLowerCase() ?? '')
const submitted = ref(false)

const loginGroup = useTemplateRef<HTMLElement>('loginGroup')
const nameInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('nameInput')
const urlInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('urlInput')
const usernameInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('usernameInput')
const passwordInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('passwordInput')

const mustEnterPassword = computed(() =>
  passwordRequired(
    { url: url.value, authMode: authMode.value, username: username.value },
    props.account,
  ),
)

// The values the server judged: its message is only true for those.
const judged = ref<{ name: string; url: string; username: string } | null>(null)
const passwordJudged = ref(false)
watch(
  () => props.serverErrors,
  async (errors) => {
    if (!errors || Object.keys(errors).length === 0) return
    judged.value = { name: name.value, url: url.value, username: username.value }
    passwordJudged.value = true
    await nextTick()
    focusFirstError()
  },
)
// A new password answers a message about the old one.
watch(password, () => {
  passwordJudged.value = false
})

const clientErrors = computed(() =>
  submitted.value
    ? validateExternalForm(
        {
          name: name.value,
          url: url.value,
          authMode: authMode.value,
          username: username.value,
          password: password.value,
        },
        { loginsEnabled: loginsAllowed.value, passwordRequired: mustEnterPassword.value },
      )
    : {},
)
const shownErrors = computed(() => {
  const server = props.serverErrors ?? {}
  const current = judged.value
  const values = { name: name.value, url: url.value, username: username.value }
  const fresh = (field: keyof typeof values) =>
    current && current[field] === values[field] ? server[field] : undefined
  return {
    authMode: clientErrors.value.authMode,
    name: clientErrors.value.name ?? fresh('name'),
    url: clientErrors.value.url ?? fresh('url'),
    username: clientErrors.value.username ?? fresh('username'),
    password: clientErrors.value.password ?? (passwordJudged.value ? server.password : undefined),
  }
})

function focusFirstError() {
  if (shownErrors.value.name) nameInput.value?.inputRef?.focus()
  else if (shownErrors.value.url) urlInput.value?.inputRef?.focus()
  else if (shownErrors.value.authMode) {
    loginGroup.value?.querySelector<HTMLElement>('[role="radio"]:not([disabled])')?.focus()
  } else if (shownErrors.value.username) usernameInput.value?.inputRef?.focus()
  else if (shownErrors.value.password) passwordInput.value?.inputRef?.focus()
}

/** For the parent: the name field, where the form starts. */
function focusFirst() {
  nameInput.value?.inputRef?.focus()
}

/** Back to an empty form for the next account. */
function reset() {
  name.value = ''
  url.value = ''
  authMode.value = 'none'
  username.value = ''
  password.value = ''
  remember.value = false
  color.value = ''
  submitted.value = false
  judged.value = null
  passwordJudged.value = false
}

defineExpose({ focusFirst, reset })

async function onSubmit() {
  if (props.busy) return
  submitted.value = true
  await nextTick()
  if (Object.keys(clientErrors.value).length > 0) {
    focusFirstError()
    return
  }
  const login = authMode.value === 'basic'
  const input: ExternalFormInput = {
    name: name.value.trim(),
    url: url.value.trim(),
    authMode: authMode.value,
    username: login ? username.value.trim() : '',
    password: login ? password.value : '',
    color: color.value,
    remember: login && remember.value,
  }
  // The password is in `input` now and nowhere else in the page: the field itself is emptied too,
  // not only the model, so no re-render has to happen for it to go.
  password.value = ''
  if (passwordInput.value?.inputRef) passwordInput.value.inputRef.value = ''
  emit('submit', input)
}
</script>
