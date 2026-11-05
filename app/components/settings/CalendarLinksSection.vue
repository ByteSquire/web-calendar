<!--
  Calendar links in Settings: the person's own links, to any calendar of the built-in service they
  see (their own, a shared one, a group's). A link shows what a share at its access level shows:
  "Busy times only" or "Can view", and no more than the person sees of the calendar. It reads the
  calendar as the person who made it, so it stops when they lose access, and while they have not
  signed in for the sign-in window. The list, the form, the address and the password are the
  component also used on the access page (LinksCalendarLinks). Design note: on this page, next to
  the app tokens, because it is the same kind of thing (a credential that outlives the session) and
  the sidebar has no room for a list with secrets. Admins also see the links of a calendar on the
  access page. Not in demo mode.
-->
<template>
  <section aria-labelledby="settings-links" class="flex flex-col gap-4">
    <h2 id="settings-links" class="text-lg font-semibold">
      {{ t('Calendar links') }}
    </h2>
    <div class="flex flex-col gap-2">
      <p>
        {{
          t(
            'Give people without an account a view of one of your calendars, behind a password. A link shows what a share at its access level shows: the busy times only, or all events with their details.',
          )
        }}
      </p>
      <p class="text-sm text-toned">
        {{
          t(
            'It shows no more than you can see, and stops working when you lose access to the calendar or do not sign in to this app for {days}.',
            { days: tc('{count} day | {count} days', windowDays) },
          )
        }}
      </p>
    </div>
    <LinksCalendarLinks :title="t('Your calendar links')" :calendar-items="calendarItems" />
  </section>
</template>

<script setup lang="ts">
import { t, tc } from '~/utils/i18n'

const serverConfig = useServerConfigState()
const windowDays = computed(() => serverConfig.value?.signinWindowDays ?? 30)
const { calendars } = useCalendarState()

// The calendars of the built-in service the person sees (their own, shared and group ones).
const calendarItems = computed(() =>
  calendars.value
    .filter(
      (calendar) => calendar.type === 'caldav' && calendar.id.startsWith('dav:') && calendar.href,
    )
    .map((calendar) => ({
      label: calendar.name,
      value: calendar.href!,
      ...(calendar.freeBusyOnly ? { freeBusyOnly: true } : {}),
    })),
)
</script>
