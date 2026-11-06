<!--
  Overflow (⋮) menu (FR-25). Nuxt UI closes it on Escape and on a click outside, moves focus into
  the menu and returns it to the trigger. On the page of a calendar link (a visitor, no account):
  only Dark mode, the language and Full screen. Signed in (live mode): the user, the time zone the times
  are shown in, Refresh (FR-10), Settings, Groups, Calendar access (admins only), Full screen, Dark mode, Help and Sign out. The demo mode
  keeps the placeholder items of the mock-up. "Full screen" is only offered where the browser has
  one for pages (not on iPhone Safari): on a phone it hides the address bar. "Dark mode" is a
  switch: it shows the scheme in use, which is the system's until it is flipped, and from then on
  on is dark and off is light. The menu stays open so the switch is seen to move. Once a scheme has
  been chosen, a circle arrow on the same row goes back to following the system; it is a menu item
  of its own (a button inside the switch's item would be out of reach of the keyboard), laid over
  the end of the switch's row. The row makes room for it only while it is there, so the menu is
  as narrow as its other rows allow until a scheme has been chosen, and then widens to fit it.
-->
<template>
  <UDropdownMenu :items="items" :content="{ align: 'end' }">
    <UButton
      :icon="loading ? 'i-lucide-loader-circle' : 'i-lucide-ellipsis-vertical'"
      :ui="{ leadingIcon: loading ? 'motion-safe:animate-spin' : '' }"
      color="neutral"
      variant="ghost"
      :aria-label="t('More options')"
      :aria-busy="loading"
    />
    <template #dark-mode-trailing>
      <!-- Only a picture of the state: the menu item is the control, so no second control inside. -->
      <span
        data-dark-mode-switch
        aria-hidden="true"
        class="inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 motion-safe:transition-colors"
        :class="
          dark
            ? 'bg-primary'
            : 'bg-accented ring-2 ring-[color:var(--app-control-border)] ring-inset'
        "
      >
        <span
          class="size-4 rounded-full bg-default shadow-xs motion-safe:transition-transform"
          :class="dark ? 'translate-x-4' : 'translate-x-0'"
        />
      </span>
    </template>
    <template #follow-system>
      <UIcon
        name="i-lucide-rotate-ccw"
        class="size-5"
        :title="followSystemLabel"
        aria-hidden="true"
      />
      <span class="sr-only">{{ followSystemLabel }}</span>
    </template>
  </UDropdownMenu>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { useAdminFlag } from '~/composables/useAdminAccess'
import { useAuth } from '~/composables/useAuth'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { useServerConfigState } from '~/composables/useServerConfigState'
import { browserStore } from '~/utils/browser-store'
import {
  LANGUAGE_NAMES,
  chooseLanguage,
  detectLocale,
  languageChoice,
  t,
  type LanguageChoice,
} from '~/utils/i18n'
import { isLiveConfig } from '~/utils/live/seed'

const toast = useToast()
const auth = useAuth()
const { currentUser } = useCalendarState()
const { loading, refresh } = useLiveStatus()
const displayTimeZone = useDisplayTimeZone()
const orgTimeZone = useOrgTimeZone()
const live = isLiveConfig(useServerConfigState().value)
const fullscreen = useFullscreen()
const colorMode = useColorMode()
const adminFlag = useAdminFlag()
const linkView = useCalendarLinkView()

/** The language, chosen in the menu (the Settings page is not there for a visitor of a link). */
function languageItems(): DropdownMenuItem[] {
  const languages = () => navigator.languages ?? [navigator.language]
  const choices: { value: LanguageChoice; label: string }[] = [
    {
      value: 'auto',
      label: t('Browser language ({language})', {
        language: LANGUAGE_NAMES[detectLocale(languages())],
      }),
    },
    { value: 'en', label: LANGUAGE_NAMES.en },
    { value: 'de', label: LANGUAGE_NAMES.de },
  ]
  return [
    { label: t('Language'), type: 'label' },
    ...choices.map((choice) => ({
      label: choice.label,
      type: 'checkbox' as const,
      checked: languageChoice.value === choice.value,
      onSelect: () => chooseLanguage(choice.value, browserStore(), languages()),
    })),
  ]
}

// Only to show the entry for the access administration; the admin routes check on the server.
watch(
  () => auth.status.value,
  (status) => {
    if (live && status === 'authenticated' && !linkView.value) void adminFlag.ensure()
  },
  { immediate: true },
)

const followSystemLabel = computed(() => t('Follow system'))

// The scheme in use (the system's, or the one the switch chose), not the stored preference.
const dark = computed(() => colorMode.value === 'dark')

function mockAction(action: string) {
  toast.add({
    title: action,
    description: t('Not available in the mock-up yet.'),
    icon: 'i-lucide-info',
  })
}

function signOut() {
  auth.logout().catch((cause: unknown) => {
    console.error('Sign-out failed', cause)
    toast.add({ title: t('Signing out failed'), color: 'error', icon: 'i-lucide-triangle-alert' })
  })
}

const items = computed<DropdownMenuItem[][]>(() => {
  const help: DropdownMenuItem = {
    label: t('Help'),
    icon: 'i-lucide-circle-help',
    onSelect: () => mockAction(t('Help')),
  }
  // Flipping it stores an explicit choice (the colour mode module keeps it in the browser's storage).
  const schemeChosen = colorMode.preference !== 'system'
  const darkMode: DropdownMenuItem = {
    label: t('Dark mode'),
    icon: 'i-lucide-moon',
    slot: 'dark-mode',
    type: 'checkbox',
    checked: dark.value,
    // The switch replaces the check mark. While the reset arrow is shown, the end of the row is
    // kept free for it (44 px and a gap), which widens the menu if this row is its widest.
    class: schemeChosen ? 'pe-12' : '',
    ui: { itemTrailingIcon: 'hidden' },
    onUpdateChecked: (checked: boolean) => {
      colorMode.preference = checked ? 'dark' : 'light'
    },
    onSelect: (event: Event) => event.preventDefault(),
  }
  // Rows are 44 px high (`min-h-11`, app.config.ts): `-mt-11` lifts this one onto the row above.
  const followSystem: DropdownMenuItem[] = schemeChosen
    ? [
        {
          label: followSystemLabel.value,
          slot: 'follow-system',
          class: '-mt-11 ms-auto w-11 justify-center px-0',
          onSelect: () => {
            colorMode.preference = 'system'
          },
        },
      ]
    : []
  const fullScreenItems: DropdownMenuItem[] = fullscreen.supported.value
    ? [
        {
          label: fullscreen.active.value ? t('Exit full screen') : t('Full screen'),
          icon: fullscreen.active.value ? 'i-lucide-minimize' : 'i-lucide-maximize',
          onSelect: () => void fullscreen.toggle(),
        },
      ]
    : []
  // The page of a calendar link: only the look of the page, for a visitor without an account.
  if (linkView.value) {
    return [[darkMode, ...followSystem], languageItems(), fullScreenItems].filter(
      (group) => group.length > 0,
    )
  }
  if (!live) {
    return [
      [
        {
          label: t('Refresh'),
          icon: 'i-lucide-refresh-cw',
          onSelect: () => mockAction(t('Refresh')),
        },
      ],
      [
        {
          label: t('Settings'),
          icon: 'i-lucide-settings',
          onSelect: () => mockAction(t('Settings')),
        },
        ...fullScreenItems,
        darkMode,
        ...followSystem,
        help,
      ],
    ]
  }

  // The name from the profile, or from the ID token while `/api/me` has not answered.
  const name = currentUser.value.name || auth.user.value?.name || ''
  const email = currentUser.value.email || auth.user.value?.email || ''
  // The times a viewer sees are in their own zone; say so, and name the organization's zone when
  // it differs because floating times and the "organization time" label refer to it (FR-29).
  const zones: DropdownMenuItem[] = [
    { label: t('Times in {zone}', { zone: displayTimeZone.value }), type: 'label' },
  ]
  if (orgTimeZone.value !== displayTimeZone.value) {
    zones.push({
      label: t('Organization time: {zone}', { zone: orgTimeZone.value }),
      type: 'label',
    })
  }
  return [
    [{ label: name || t('Signed in'), ...(email ? { description: email } : {}), type: 'label' }],
    zones,
    [
      {
        label: t('Refresh'),
        icon: 'i-lucide-refresh-cw',
        // The menu closes; the trigger shows the progress (spinner, aria-busy).
        loading: loading.value,
        onSelect: () => void refresh(),
      },
    ],
    [
      { label: t('Settings'), icon: 'i-lucide-settings', to: '/settings' },
      // Groups and their calendars: for everybody signed in (the server limits what each may do).
      { label: t('Groups'), icon: 'i-lucide-users-round', to: '/groups' },
      // The administration pages: admins only (each page and its routes check again).
      ...(adminFlag.admin.value === true
        ? [
            { label: t('Calendars'), icon: 'i-lucide-shield-check', to: '/admin/calendars' },
            { label: t('People'), icon: 'i-lucide-contact', to: '/admin/people' },
            { label: t('Resources'), icon: 'i-lucide-door-open', to: '/admin/resources' },
          ]
        : []),
      ...fullScreenItems,
      darkMode,
      ...followSystem,
      help,
    ],
    [{ label: t('Sign out'), icon: 'i-lucide-log-out', onSelect: signOut }],
  ]
})
</script>
