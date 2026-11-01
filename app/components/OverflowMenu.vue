<!--
  Overflow (⋮) menu (FR-25). Nuxt UI closes it on Escape and on a click outside, moves focus into
  the menu and returns it to the trigger. Signed in (live mode): the user, the time zone the times
  are shown in, Refresh (FR-10), Settings, Full screen, Appearance, Help and Sign out. The demo mode
  keeps the placeholder items of the mock-up. "Full screen" is only offered where the browser has
  one for pages (not on iPhone Safari): on a phone it hides the address bar. "Appearance" chooses
  the colour scheme: the system's (the default), light or dark. Some phone browsers (Huawei's
  "night mode") darken pages themselves and do not tell the page, so the choice is made here.
-->
<template>
  <UDropdownMenu :items="items" :content="{ align: 'end' }">
    <UButton
      :icon="loading ? 'i-lucide-loader-circle' : 'i-lucide-ellipsis-vertical'"
      :ui="{ leadingIcon: loading ? 'motion-safe:animate-spin' : '' }"
      color="neutral"
      variant="ghost"
      aria-label="More options"
      :aria-busy="loading"
    />
  </UDropdownMenu>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { useAuth } from '~/composables/useAuth'
import { useLiveStatus } from '~/composables/useLiveCalendar'
import { useServerConfigState } from '~/composables/useServerConfigState'
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

const APPEARANCES = [
  { value: 'system', label: 'System default', icon: 'i-lucide-monitor' },
  { value: 'light', label: 'Light', icon: 'i-lucide-sun' },
  { value: 'dark', label: 'Dark', icon: 'i-lucide-moon' },
] as const

function mockAction(action: string) {
  toast.add({
    title: action,
    description: 'Not available in the mock-up yet.',
    icon: 'i-lucide-info',
  })
}

function signOut() {
  auth.logout().catch((cause: unknown) => {
    console.error('Sign-out failed', cause)
    toast.add({ title: 'Signing out failed', color: 'error', icon: 'i-lucide-triangle-alert' })
  })
}

const items = computed<DropdownMenuItem[][]>(() => {
  const help: DropdownMenuItem = {
    label: 'Help',
    icon: 'i-lucide-circle-help',
    onSelect: () => mockAction('Help'),
  }
  // The choice is kept by the colour mode module (in the browser's storage).
  const appearance: DropdownMenuItem = {
    label: 'Appearance',
    icon: 'i-lucide-sun-moon',
    children: APPEARANCES.map(({ value, label, icon }) => ({
      label,
      icon,
      type: 'checkbox' as const,
      checked: colorMode.preference === value,
      onSelect: () => {
        colorMode.preference = value
      },
    })),
  }
  const fullScreenItems: DropdownMenuItem[] = fullscreen.supported.value
    ? [
        {
          label: fullscreen.active.value ? 'Exit full screen' : 'Full screen',
          icon: fullscreen.active.value ? 'i-lucide-minimize' : 'i-lucide-maximize',
          onSelect: () => void fullscreen.toggle(),
        },
      ]
    : []
  if (!live) {
    return [
      [{ label: 'Refresh', icon: 'i-lucide-refresh-cw', onSelect: () => mockAction('Refresh') }],
      [
        { label: 'Settings', icon: 'i-lucide-settings', onSelect: () => mockAction('Settings') },
        ...fullScreenItems,
        appearance,
        help,
      ],
    ]
  }

  // The name from the profile, or from the ID token while `/api/me` has not answered.
  const name = currentUser.value.name || auth.user.value?.name || ''
  const email = currentUser.value.email || auth.user.value?.email || ''
  // The times a viewer sees are in their own zone; say so, and name the organization's zone when
  // it differs because floating times and the "organization time" label refer to it (FR-29).
  const zones: DropdownMenuItem[] = [{ label: `Times in ${displayTimeZone.value}`, type: 'label' }]
  if (orgTimeZone.value !== displayTimeZone.value) {
    zones.push({ label: `Organization time: ${orgTimeZone.value}`, type: 'label' })
  }
  return [
    [{ label: name || 'Signed in', ...(email ? { description: email } : {}), type: 'label' }],
    zones,
    [
      {
        label: 'Refresh',
        icon: 'i-lucide-refresh-cw',
        // The menu closes; the trigger shows the progress (spinner, aria-busy).
        loading: loading.value,
        onSelect: () => void refresh(),
      },
    ],
    [
      { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
      ...fullScreenItems,
      appearance,
      help,
    ],
    [{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut }],
  ]
})
</script>
