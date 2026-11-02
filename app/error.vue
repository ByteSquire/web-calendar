<!--
  Nuxt's error page (an unknown address, a page that failed to load): in the app's language and
  look instead of Nuxt's built-in English page. Nothing of the error's detail is shown.
-->
<template>
  <UApp :locale="uiLocale">
    <main class="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold">{{ title }}</h1>
      <p class="text-muted">
        {{
          notFound
            ? t('This address does not exist in Web Calendar.')
            : t('Something went wrong. Try again; if it keeps happening, ask an administrator.')
        }}
      </p>
      <div>
        <UButton @click="clearError({ redirect: '/' })">{{ t('Back to calendar') }}</UButton>
      </div>
    </main>
  </UApp>
</template>

<script setup lang="ts">
import type { NuxtError } from '#app'
import { de, en } from '@nuxt/ui/locale'
import { locale, t } from '~/utils/i18n'

const props = defineProps<{ error: NuxtError }>()

const uiLocale = computed(() => (locale.value === 'de' ? de : en))
const notFound = computed(() => props.error.statusCode === 404)
const title = computed(() => (notFound.value ? t('Page not found') : t('Something went wrong')))
useHead({ title, htmlAttrs: { lang: locale } })

const heading = useTemplateRef<HTMLElement>('heading')
onMounted(() => heading.value?.focus())
</script>
