<!--
  Language: English, German, or the browser's. The choice is kept in this browser (localStorage)
  and applies at once; it does not follow the person to another device, as the time zone does.
  The names of the languages are written in each language and are not translated. A select and
  not radio buttons: Reka UI names a radio button after its label once, when it is drawn, so that
  name would stay in the old language after the switch.
-->
<template>
  <section aria-labelledby="settings-language" class="flex flex-col gap-4">
    <h2 id="settings-language" tabindex="-1" class="text-lg font-semibold">{{ t('Language') }}</h2>
    <p>{{ t('The language of the app on this device. By default it follows your browser.') }}</p>
    <UFormField :label="t('Language')">
      <USelect
        :model-value="languageChoice"
        :items="items"
        value-key="value"
        class="w-full max-w-md"
        :ui="SELECT_UI"
        @update:model-value="choose"
      />
    </UFormField>
  </section>
</template>

<script setup lang="ts">
import { browserStore } from '~/utils/browser-store'
import {
  LANGUAGE_NAMES,
  chooseLanguage,
  detectLocale,
  languageChoice,
  t,
  type LanguageChoice,
} from '~/utils/i18n'

// 44 px rows, as the other selects of the settings (design §9).
const SELECT_UI = { base: 'min-h-11', item: 'min-h-11 items-center' }

const languages = () => navigator.languages ?? [navigator.language]

const items = computed(() => [
  {
    value: 'auto',
    label: t('Browser language ({language})', {
      language: LANGUAGE_NAMES[detectLocale(languages())],
    }),
  },
  { value: 'en', label: LANGUAGE_NAMES.en },
  { value: 'de', label: LANGUAGE_NAMES.de },
])

function choose(value: unknown) {
  if (value === 'auto' || value === 'en' || value === 'de') {
    chooseLanguage(value as LanguageChoice, browserStore(), languages())
  }
}
</script>
