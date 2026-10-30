<!--
  The form of an iCal subscription (FR-7), for adding and for changing one. It checks the input
  itself first (utils/settings/validation.ts) and shows what the server rejected next to the
  input it is about; a server message disappears as soon as that input is edited, because the
  message is about the value that was sent. The parent does the request.
-->
<template>
  <form novalidate class="flex flex-col gap-4" @submit.prevent="onSubmit">
    <UFormField label="Name" name="name" required :error="shownErrors.name" :ui="FIELD_UI">
      <UInput ref="nameInput" v-model="name" autocomplete="off" class="w-full" />
    </UFormField>

    <UFormField
      label="Address of the .ics file"
      name="url"
      required
      help="An http://, https:// or webcal:// link to a calendar file."
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
import { colorChoices, initialColor } from '~/utils/settings/palette'
import type { Subscription, SubscriptionInput } from '~/utils/settings/types'
import { FIELD_UI } from '~/utils/settings/ui'
import { validateSubscriptionForm } from '~/utils/settings/validation'

const props = defineProps<{
  /** The subscription being changed; none when adding. */
  subscription?: Subscription
  submitLabel: string
  busy: boolean
  cancelable?: boolean
  /** Field messages from the server (`name`, `url`, `color`). */
  serverErrors?: Record<string, string>
}>()
const emit = defineEmits<{ submit: [input: SubscriptionInput]; cancel: [] }>()

const editing = computed(() => props.subscription !== undefined)
const choices = computed(() => colorChoices(props.subscription?.color, editing.value))

const name = ref(props.subscription?.name ?? '')
const url = ref(props.subscription?.url ?? '')
const color = ref(initialColor(props.subscription?.color, editing.value))
const submitted = ref(false)

const nameInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('nameInput')
const urlInput = useTemplateRef<{ inputRef: HTMLInputElement | null }>('urlInput')

// The values the server judged: its message is only true for those.
const judged = ref<{ name: string; url: string } | null>(null)
watch(
  () => props.serverErrors,
  async (errors) => {
    if (!errors || Object.keys(errors).length === 0) return
    judged.value = { name: name.value, url: url.value }
    await nextTick()
    focusFirstError()
  },
)

const clientErrors = computed(() =>
  submitted.value ? validateSubscriptionForm({ name: name.value, url: url.value }) : {},
)
const shownErrors = computed(() => {
  const server = props.serverErrors ?? {}
  const current = judged.value
  return {
    name:
      clientErrors.value.name ?? (current && current.name === name.value ? server.name : undefined),
    url: clientErrors.value.url ?? (current && current.url === url.value ? server.url : undefined),
  }
})

function focusFirstError() {
  if (shownErrors.value.name) nameInput.value?.inputRef?.focus()
  else if (shownErrors.value.url) urlInput.value?.inputRef?.focus()
}

/** For the parent: the name field, where the form starts. */
function focusFirst() {
  nameInput.value?.inputRef?.focus()
}

/** Back to an empty form for the next subscription. */
function reset() {
  name.value = ''
  url.value = ''
  color.value = initialColor(undefined, false)
  submitted.value = false
  judged.value = null
}

defineExpose({ focusFirst, reset })

async function onSubmit() {
  if (props.busy) return
  submitted.value = true
  await nextTick()
  if (clientErrors.value.name || clientErrors.value.url) {
    focusFirstError()
    return
  }
  emit('submit', { name: name.value.trim(), url: url.value.trim(), color: color.value })
}
</script>
