import { Temporal } from 'temporal-polyfill'
import type {
  Calendar,
  CalendarEvent,
  CalendarFilter,
  CalendarResource,
  CalendarUser,
  CalendarView,
  Category,
} from '../../shared/types/calendar'

export interface MockData {
  currentUser: CalendarUser
  views: CalendarView[]
  calendars: Calendar[]
  resources: CalendarResource[]
  categories: Category[]
  filters: CalendarFilter[]
  events: CalendarEvent[]
}

// Phase 1 mock data. Replace with API calls in Phase 2.

const currentUser: CalendarUser = {
  id: 'user-1',
  oidcSub: 'mock-sub-1',
  name: 'Alex Doe',
  email: 'alex@example.com',
}

const categories: Category[] = [
  { id: 'cat-work', name: 'Work', color: '#1d4ed8' },
  { id: 'cat-personal', name: 'Personal', color: '#047857' },
  { id: 'cat-meeting', name: 'Meeting', color: '#6d28d9' },
  { id: 'cat-travel', name: 'Travel', color: '#b45309' },
  { id: 'cat-focus', name: 'Focus', color: '#0f766e' },
  { id: 'cat-holiday', name: 'Holiday', color: '#b91c1c' },
]

const calendars: Calendar[] = [
  {
    id: 'cal-personal',
    name: 'Personal',
    type: 'caldav',
    color: '#1d4ed8',
    defaultVisible: true,
    ownerId: currentUser.id,
    // the person's default calendar: renamed, never deleted
    manage: { kind: 'own', default: true },
  },
  {
    id: 'cal-team',
    name: 'Team',
    type: 'caldav',
    color: '#047857',
    defaultVisible: true,
    ownerId: currentUser.id,
    manage: { kind: 'own' },
  },
  {
    id: 'cal-engineering',
    name: 'Engineering',
    type: 'caldav',
    color: '#6d28d9',
    defaultVisible: true,
  },
  {
    id: 'cal-sales',
    name: 'Sales',
    type: 'caldav',
    color: '#b45309',
    defaultVisible: false,
  },
  {
    id: 'cal-holidays',
    name: 'Public holidays',
    type: 'ical',
    color: '#b91c1c',
    defaultVisible: true,
    sourceUrl: 'https://example.com/holidays.ics',
  },
  {
    // Empty calendar: exercises split-view band hiding.
    id: 'cal-office',
    name: 'Office',
    type: 'caldav',
    color: '#0f766e',
    defaultVisible: false,
  },
  {
    // Empty calendar: exercises split-view band hiding.
    id: 'cal-marketing',
    name: 'Marketing',
    type: 'ical',
    color: '#9d174d',
    defaultVisible: false,
    sourceUrl: 'https://example.com/marketing.ics',
  },
  {
    id: 'cal-room-a',
    name: 'Room A',
    type: 'resource',
    color: '#4d7c0f',
    defaultVisible: true,
    resourceType: 'room',
  },
  {
    id: 'cal-van',
    name: 'Van',
    type: 'resource',
    color: '#0e7490',
    defaultVisible: true,
    resourceType: 'car',
  },
]

const resources: CalendarResource[] = [
  {
    id: 'res-room-a',
    calendarId: 'cal-room-a',
    name: 'Room A',
    type: 'room',
    location: 'Building 1, 2nd floor',
    capacity: 8,
  },
  {
    id: 'res-van',
    calendarId: 'cal-van',
    name: 'Van',
    type: 'car',
    location: 'Garage',
    capacity: 9,
  },
]

const allCalendarIds = calendars.map((calendar) => calendar.id)

const views: CalendarView[] = [
  {
    id: 'view-my-week',
    name: 'My week',
    icon: 'calendar',
    calendarIds: ['cal-personal', 'cal-team', 'cal-holidays'],
    isAdmin: false,
    ownerId: currentUser.id,
  },
  {
    id: 'view-team',
    name: 'Team',
    icon: 'users',
    calendarIds: ['cal-team', 'cal-engineering', 'cal-sales', 'cal-room-a', 'cal-van'],
    isAdmin: false,
    ownerId: currentUser.id,
  },
  {
    id: 'view-everything',
    name: 'Everything',
    icon: 'layers',
    calendarIds: allCalendarIds,
    isAdmin: false,
    ownerId: currentUser.id,
  },
  {
    id: 'view-all-staff',
    name: 'All staff',
    icon: 'shield',
    calendarIds: allCalendarIds,
    isAdmin: true,
  },
]

const filters: CalendarFilter[] = [
  { id: 'filter-work', name: 'Work only', kind: 'category', value: 'cat-work' },
  {
    id: 'filter-hide-cancelled',
    name: 'Hide cancelled',
    kind: 'status',
    value: 'cancelled',
  },
  { id: 'filter-offsite', name: 'Offsite', kind: 'text', value: 'offsite' },
]

function makeEvent(input: Omit<CalendarEvent, 'uid'>): CalendarEvent {
  return { uid: input.id, ...input }
}

/**
 * Build the mock dataset around the week containing `today`.
 * Tests pass a fixed anchor to get a deterministic dataset.
 */
export function createMockData(today: Temporal.PlainDate = Temporal.Now.plainDateISO()): MockData {
  const monday = today.subtract({ days: today.dayOfWeek - 1 })
  const day = (offset: number) => monday.add({ days: offset })
  const date = (value: Temporal.PlainDate) => value.toString()
  const at = (value: Temporal.PlainDate, time: string) => `${value.toString()}T${time}:00`

  const events: CalendarEvent[] = [
    makeEvent({
      id: 'evt-standup',
      calendarId: 'cal-personal',
      title: 'Standup',
      start: at(day(0), '09:00'),
      end: at(day(0), '09:15'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-meeting'],
      location: 'Video call',
    }),
    makeEvent({
      id: 'evt-focus',
      calendarId: 'cal-personal',
      title: 'Focus block: roadmap',
      start: at(day(1), '08:00'),
      end: at(day(1), '11:30'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-focus'],
    }),
    makeEvent({
      id: 'evt-dentist',
      calendarId: 'cal-personal',
      title: 'Dentist',
      start: at(day(2), '17:00'),
      end: at(day(2), '18:00'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-personal'],
      location: 'Main Street 12',
    }),
    makeEvent({
      id: 'evt-coast',
      calendarId: 'cal-personal',
      title: 'Trip to the coast',
      start: date(day(5)),
      end: date(day(7)),
      allDay: true,
      status: 'confirmed',
      categoryIds: ['cat-personal', 'cat-travel'],
    }),
    makeEvent({
      id: 'evt-sprint-planning',
      calendarId: 'cal-team',
      title: 'Sprint planning',
      start: at(day(0), '10:00'),
      end: at(day(0), '11:30'),
      allDay: false,
      status: 'confirmed',
      description: 'Plan the next two-week sprint.',
      location: 'Room A',
      categoryIds: ['cat-meeting', 'cat-work'],
    }),
    makeEvent({
      id: 'evt-offsite',
      calendarId: 'cal-team',
      title: 'Engineering offsite',
      start: date(day(1)),
      end: date(day(4)),
      allDay: true,
      status: 'confirmed',
      location: 'Lakeside Lodge',
      categoryIds: ['cat-work', 'cat-travel'],
    }),
    makeEvent({
      id: 'evt-design-review',
      calendarId: 'cal-team',
      title: 'Design review',
      start: at(day(2), '14:00'),
      end: at(day(2), '15:00'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-meeting'],
    }),
    makeEvent({
      id: 'evt-one-on-one',
      calendarId: 'cal-team',
      title: '1:1 with Sam',
      start: at(day(3), '16:00'),
      end: at(day(3), '16:30'),
      allDay: false,
      status: 'tentative',
      categoryIds: ['cat-meeting'],
    }),
    makeEvent({
      id: 'evt-vendor-demo',
      calendarId: 'cal-team',
      title: 'Vendor demo',
      start: at(day(3), '11:00'),
      end: at(day(3), '12:00'),
      allDay: false,
      status: 'cancelled',
      categoryIds: ['cat-meeting'],
    }),
    makeEvent({
      id: 'evt-retro',
      calendarId: 'cal-team',
      title: 'Sprint retro',
      start: at(day(4), '15:00'),
      end: at(day(4), '16:00'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-meeting'],
    }),
    makeEvent({
      id: 'evt-incident-review',
      calendarId: 'cal-engineering',
      title: 'Incident review',
      start: at(day(1), '09:00'),
      end: at(day(1), '10:00'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-work'],
    }),
    makeEvent({
      id: 'evt-deploy',
      calendarId: 'cal-engineering',
      title: 'Production deploy window',
      start: at(day(3), '20:00'),
      end: at(day(3), '22:00'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-work'],
    }),
    makeEvent({
      id: 'evt-quarterly-planning',
      calendarId: 'cal-engineering',
      title: 'Quarterly planning',
      start: at(day(-5), '13:00'),
      end: at(day(-5), '15:00'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-work'],
    }),
    makeEvent({
      // Outside the current week: Sales has an empty band in week view.
      id: 'evt-pipeline-review',
      calendarId: 'cal-sales',
      title: 'Pipeline review',
      start: at(day(23), '10:00'),
      end: at(day(23), '11:00'),
      allDay: false,
      status: 'confirmed',
      categoryIds: ['cat-work'],
    }),
    makeEvent({
      id: 'evt-company-holiday',
      calendarId: 'cal-holidays',
      title: 'Company holiday',
      start: date(day(4)),
      end: date(day(5)),
      allDay: true,
      status: 'confirmed',
      categoryIds: ['cat-holiday'],
    }),
    makeEvent({
      id: 'evt-room-a-booking',
      calendarId: 'cal-room-a',
      title: 'Design workshop',
      start: at(day(2), '10:00'),
      end: at(day(2), '12:00'),
      allDay: false,
      status: 'confirmed',
      location: 'Room A',
      categoryIds: ['cat-meeting'],
      resourceId: 'res-room-a',
      bookedByCalendarId: 'cal-team',
    }),
    makeEvent({
      // Details hidden: the booking calendar is not visible to this user.
      id: 'evt-van-blocked',
      calendarId: 'cal-van',
      title: 'Busy',
      start: date(day(3)),
      end: date(day(4)),
      allDay: true,
      status: 'confirmed',
      categoryIds: [],
      resourceId: 'res-van',
      bookedByCalendarId: 'cal-sales',
      isBlocked: true,
    }),
  ]

  return structuredClone({
    currentUser,
    views,
    calendars,
    resources,
    categories,
    filters,
    events,
  })
}
