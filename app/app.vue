<template>
  <UApp :locale="uiLocale">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script setup lang="ts">
import { de, en } from '@nuxt/ui/locale'
import { locale } from '~/utils/i18n'

// The words of Nuxt UI's own parts (the close button, the empty list) follow the language, and so
// does `lang` of the page, which screen readers use to pick the voice.
const uiLocale = computed(() => (locale.value === 'de' ? de : en))
useHead({ htmlAttrs: { lang: locale } })
</script>
