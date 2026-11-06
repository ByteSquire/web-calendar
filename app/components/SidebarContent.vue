<!--
  Sidebar body (FR-21): views, calendars, resources, categories, filters, all from the shared
  calendar state. Rendered inside the desktop column and inside the mobile slideover. The sections
  come in the order the person keeps them in (saved for the account). They are dragged by their
  headings (a long press first on a touch screen); the list with arrow buttons that arranges them
  without dragging replaces the sections until it is closed.
-->
<template>
  <div
    ref="root"
    class="flex flex-col gap-3 p-2"
    @pointerdown="drag.onPointerDown"
    @contextmenu="drag.onContextMenu"
  >
    <SidebarProblems />

    <SidebarArrange v-if="arranging" @done="stopArranging" />
    <template v-else>
      <!-- In the order the person keeps them in: the page order is the reading and Tab order. -->
      <template v-for="id in order" :key="id">
        <SidebarSection
          v-if="id === 'views'"
          :data-section-id="id"
          :title="SECTION_TITLES.views"
          add-noun="view"
          :add-submit="submitOwnView"
        >
          <ul>
            <li v-for="view in views" :key="view.id">
              <SidebarViewItem
                :view="view"
                :selected="view.id === selectedViewId"
                :can-manage="isAdmin"
                @select="toggleView(view.id)"
                @rename="startRename(view)"
                @update="updateFromSelection(view)"
                @delete="startDelete(view)"
                @copy="copyView(view)"
                @share="shareView(view)"
                @unshare="unshareSharedView(view)"
              />
            </li>
          </ul>
        </SidebarSection>

        <SidebarSection
          v-else-if="id === 'calendars'"
          :data-section-id="id"
          :title="SECTION_TITLES.calendars"
          :add-noun="canCreateCalendars ? 'calendar' : undefined"
          :add-submit="submitCalendar"
        >
          <ul>
            <li
              v-for="calendar in regularCalendars"
              :key="calendar.id"
              class="flex items-center gap-1"
            >
              <SidebarToggleRow
                class="min-w-0 flex-1"
                :label="calendar.name"
                :color="calendar.color"
                :model-value="visibleCalendarIds.includes(calendar.id)"
                @update:model-value="setCalendarVisible(calendar.id, $event)"
              />
              <UButton
                icon="i-lucide-palette"
                color="neutral"
                variant="ghost"
                square
                class="min-h-11 min-w-11 shrink-0 justify-center"
                :aria-label="t('Colour of {name}', { name: calendar.name })"
                @click="colorTarget = calendar"
              />
            </li>
          </ul>
        </SidebarSection>

        <SidebarSection
          v-else-if="id === 'resources'"
          :data-section-id="id"
          :title="SECTION_TITLES.resources"
        >
          <ul>
            <li v-for="resource in resources" :key="resource.id">
              <SidebarToggleRow
                :label="resource.name"
                :icon="resourceIconName(resource.type)"
                :color="calendarById.get(resource.calendarId)?.color"
                :model-value="visibleResourceIds.includes(resource.id)"
                @update:model-value="setResourceVisible(resource.id, $event)"
              />
            </li>
          </ul>
          <NuxtLink
            to="/resources/requests"
            class="inline-flex min-h-11 items-center gap-1.5 px-2 underline"
          >
            <UIcon name="i-lucide-inbox" class="size-4" aria-hidden="true" />
            {{ t('Resource bookings') }}
          </NuxtLink>
        </SidebarSection>

        <SidebarSection
          v-else-if="id === 'categories'"
          :data-section-id="id"
          :title="SECTION_TITLES.categories"
          add-noun="category"
          :add-submit="submitCategory"
        >
          <ul>
            <li v-for="category in categories" :key="category.id">
              <SidebarToggleRow
                :label="category.name"
                :color="category.color"
                :model-value="selectedCategoryIds.includes(category.id)"
                @update:model-value="setCategorySelected(category.id, $event)"
              />
            </li>
          </ul>
        </SidebarSection>

        <SidebarSection
          v-else-if="id === 'filters'"
          :data-section-id="id"
          :title="SECTION_TITLES.filters"
          add-noun="filter"
          :add-submit="submitFilter"
        >
          <ul>
            <li v-for="filter in filters" :key="filter.id">
              <SidebarToggleRow
                :label="filter.name"
                :model-value="activeFilterIds.includes(filter.id)"
                @update:model-value="setFilterActive(filter.id, $event)"
              />
            </li>
          </ul>
        </SidebarSection>
      </template>

      <UButton
        ref="arrangeButton"
        :label="t('Arrange sections')"
        icon="i-lucide-arrow-up-down"
        color="neutral"
        variant="ghost"
        class="min-h-11 self-start text-toned"
        @click="arranging = true"
      />
    </template>

    <AdminViewRenameModal
      :open="renaming !== null"
      :view-name="renaming?.name ?? ''"
      :shared="renaming?.isAdmin ?? true"
      :pending="pending"
      :error="dialogError"
      @update:open="closeDialogs"
      @save="saveRename"
    />
    <ConfirmDeleteDialog
      :open="deleting !== null"
      :event-title="deleting?.name ?? ''"
      :detail="
        deleting?.isAdmin
          ? t('The shared view disappears for everybody.')
          : t('Only this view is deleted; the calendars stay.')
      "
      :pending="pending"
      :error="dialogError"
      @update:open="closeDialogs"
      @confirm="confirmDelete"
    />
    <CalendarColorDialog :calendar="colorTarget" @close="colorTarget = null" />
  </div>
</template>

<script setup lang="ts">
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useCalDav } from '~/composables/useCalDav'
import { useCalendarSourcesVersion } from '~/composables/useLiveCalendar'
import { useServerConfigState } from '~/composables/useServerConfigState'
import {
  deleteSharedView,
  describeSharedViewError,
  fetchIsAdmin,
  sharedViewBody,
  updateSharedView,
  type AdminViewsApi,
} from '~/utils/live/admin-views'
import { t } from '~/utils/i18n'
import { SECTION_TITLES } from '~/utils/sidebar-sections'
import { calendarNameProblem } from '~/utils/groups/model'
import { describeLoadError } from '~/utils/live/errors'
import { isLiveConfig } from '~/utils/live/seed'
import {
  copyName,
  createOwnView,
  deleteOwnView,
  describeOwnViewError,
  ownViewBody,
  shareOwnView,
  unshareView,
  updateOwnView,
  type SharedOwnView,
  type UnsharedView,
} from '~/utils/live/user-views'
import type { Calendar, CalendarView, ViewIcon } from '../../shared/types/calendar'

const {
  views,
  selectedViewId,
  selectView,
  regularCalendars,
  calendarById,
  visibleCalendarIds,
  setCalendarVisible,
  resources,
  visibleResourceIds,
  setResourceVisible,
  categories,
  selectedCategoryIds,
  setCategorySelected,
  addCategory,
  filters,
  activeFilterIds,
  setFilterActive,
  addFilter,
} = useCalendarState()

/** The calendar whose colour dialog is open. */
const colorTarget = ref<Calendar | null>(null)

// Shared views are changed through `/api/admin/views` in live mode, a user's own views through
// `/api/views`. The shared-view controls show for admins only (the server checks again); without a
// server (demo, mock data) both kinds change the local list.
const live = isLiveConfig(useServerConfigState().value)
const api = live ? (useAuthFetch() as unknown as AdminViewsApi) : null
const isAdmin = ref(!live)
onMounted(async () => {
  if (!api) return
  try {
    isAdmin.value = await fetchIsAdmin(api)
  } catch {
    isAdmin.value = false
  }
})

/** The requests and the wording of failures for each kind of view. */
const SHARED = {
  body: sharedViewBody,
  update: updateSharedView,
  remove: deleteSharedView,
  describe: describeSharedViewError,
}
const OWN = {
  body: ownViewBody,
  update: updateOwnView,
  remove: deleteOwnView,
  describe: describeOwnViewError,
}
const requestsFor = (view: CalendarView) => (view.isAdmin ? SHARED : OWN)

const toast = useToast()
const renaming = ref<CalendarView | null>(null)
const deleting = ref<CalendarView | null>(null)
const pending = ref(false)
const dialogError = ref('')
let localCounter = 0
let ownCounter = 0

function replaceView(next: CalendarView) {
  views.value = views.value.map((view) => (view.id === next.id ? next : view))
}

/** A new view of the user's own with these calendars; on the server, or in the local list (demo). */
async function createOwn(
  name: string,
  icon: ViewIcon,
  calendarIds: readonly string[],
): Promise<CalendarView> {
  const body = ownViewBody(name, icon, calendarIds)
  if (api) return createOwnView(api, body)
  ownCounter += 1
  return {
    id: `view-own-${ownCounter}`,
    name,
    icon,
    calendarIds: body.calendars.map((calendar) => calendar.ref),
    isAdmin: false,
  }
}

const ownNames = () => views.value.filter((view) => !view.isAdmin).map((view) => view.name)

async function submitOwnView(name: string): Promise<string | undefined> {
  if (ownNames().includes(name)) return t('A view with this name already exists.')
  try {
    views.value = [...views.value, await createOwn(name, 'calendar', visibleCalendarIds.value)]
    return undefined
  } catch (error) {
    return describeOwnViewError(error)
  }
}

/** "Duplicate" on an own view and "Copy to my views" on a shared one: a copy of the user's own. */
async function copyView(view: CalendarView) {
  try {
    const created = await createOwn(copyName(view.name, ownNames()), view.icon, view.calendarIds)
    views.value = [...views.value, created]
    toast.add({
      title: t('Added {name} to your views', { name: created.name }),
      icon: 'i-lucide-check',
    })
  } catch (error) {
    toast.add({ title: describeOwnViewError(error), color: 'error', icon: 'i-lucide-x' })
  }
}

/**
 * "Share with everybody" on an administrator's own view: the shared view takes its place (see
 * `shareOwnView`). If the own view could not be deleted both are listed and the toast says so.
 */
async function shareView(view: CalendarView) {
  if (views.value.some((item) => item.isAdmin && item.name === view.name)) {
    toast.add({
      title: t('A shared view with this name already exists. Rename this view first.'),
      color: 'error',
      icon: 'i-lucide-x',
    })
    return
  }
  let result: SharedOwnView
  try {
    if (api) {
      result = await shareOwnView(api, view)
    } else {
      localCounter += 1
      const body = sharedViewBody(view.name, view.icon, view.calendarIds)
      result = {
        shared: {
          id: `view-shared-${localCounter}`,
          name: view.name,
          icon: view.icon,
          calendarIds: body.calendars.map((calendar) => calendar.ref),
          isAdmin: true,
        },
        leftOut: new Set(view.calendarIds).size - body.calendars.length,
      }
    }
  } catch (error) {
    toast.add({ title: describeSharedViewError(error), color: 'error', icon: 'i-lucide-x' })
    return
  }
  const { shared, leftOut, removeError } = result
  if (removeError !== undefined) {
    views.value = [...views.value, shared]
    toast.add({
      title: t('Shared {name}, but your own view could not be removed.', { name: view.name }),
      description: describeOwnViewError(removeError),
      color: 'error',
      icon: 'i-lucide-x',
    })
    return
  }
  views.value = views.value.map((item) => (item.id === view.id ? shared : item))
  if (selectedViewId.value === view.id) selectView(shared.id)
  toast.add({
    title: t('Shared {name} with everybody', { name: view.name }),
    description: leftOut > 0 ? t('External calendars are not shared.') : undefined,
    icon: 'i-lucide-check',
  })
}

/**
 * "Unshare" on a shared view: it becomes a view of the administrator's own and disappears for
 * everybody else (see `unshareView`). If the shared view could not be deleted both are listed and
 * the toast says so.
 */
async function unshareSharedView(view: CalendarView) {
  if (ownNames().includes(view.name)) {
    toast.add({
      title: t('You already have a view with this name. Rename one of them first.'),
      color: 'error',
      icon: 'i-lucide-x',
    })
    return
  }
  let result: UnsharedView
  try {
    if (api) {
      result = await unshareView(api, view)
    } else {
      ownCounter += 1
      const body = ownViewBody(view.name, view.icon, view.calendarIds)
      result = {
        own: {
          id: `view-own-${ownCounter}`,
          name: view.name,
          icon: view.icon,
          calendarIds: body.calendars.map((calendar) => calendar.ref),
          isAdmin: false,
        },
      }
    }
  } catch (error) {
    toast.add({ title: describeOwnViewError(error), color: 'error', icon: 'i-lucide-x' })
    return
  }
  const { own, removeError } = result
  if (removeError !== undefined) {
    views.value = [...views.value, own]
    toast.add({
      title: t('Copied {name} to your views, but the shared view could not be removed.', {
        name: view.name,
      }),
      description: describeSharedViewError(removeError),
      color: 'error',
      icon: 'i-lucide-x',
    })
    return
  }
  views.value = views.value.map((item) => (item.id === view.id ? own : item))
  if (selectedViewId.value === view.id) selectView(own.id)
  toast.add({
    title: t('Unshared {name}', { name: view.name }),
    description: t('It is one of your own views now; other people no longer see it.'),
    icon: 'i-lucide-check',
  })
}

async function updateFromSelection(view: CalendarView) {
  try {
    const body = sharedViewBody(view.name, view.icon, visibleCalendarIds.value)
    const next = api
      ? await updateSharedView(api, view.id, body)
      : { ...view, calendarIds: body.calendars.map((calendar) => calendar.ref) }
    replaceView(next)
    toast.add({
      title: t('Updated shared view {name}', { name: view.name }),
      icon: 'i-lucide-check',
    })
  } catch (error) {
    toast.add({ title: describeSharedViewError(error), color: 'error', icon: 'i-lucide-x' })
  }
}

function startRename(view: CalendarView) {
  dialogError.value = ''
  renaming.value = view
}

function startDelete(view: CalendarView) {
  dialogError.value = ''
  deleting.value = view
}

function closeDialogs() {
  renaming.value = null
  deleting.value = null
}

async function saveRename(name: string) {
  const view = renaming.value
  if (!view) return
  pending.value = true
  dialogError.value = ''
  try {
    // Renaming keeps the calendars the view has: the request repeats them.
    const requests = requestsFor(view)
    const body = requests.body(name, view.icon, view.calendarIds)
    replaceView(api ? await requests.update(api, view.id, body) : { ...view, name })
    closeDialogs()
  } catch (error) {
    dialogError.value = requestsFor(view).describe(error)
  } finally {
    pending.value = false
  }
}

async function confirmDelete() {
  const view = deleting.value
  if (!view) return
  pending.value = true
  dialogError.value = ''
  try {
    if (api) await requestsFor(view).remove(api, view.id)
    views.value = views.value.filter((item) => item.id !== view.id)
    if (selectedViewId.value === view.id) selectView(null)
    closeDialogs()
  } catch (error) {
    dialogError.value = requestsFor(view).describe(error)
  } finally {
    pending.value = false
  }
}

// ---- Order of the sections --------------------------------------------------------------------

const root = useTemplateRef<HTMLElement>('root')
const drag = useSidebarDrag(root)
const { order } = useSidebarOrder()
const arranging = ref(false)
const arrangeButton = useTemplateRef<{ $el: HTMLElement }>('arrangeButton')

async function stopArranging() {
  arranging.value = false
  await nextTick()
  arrangeButton.value?.$el.focus()
}

// Selecting the active view again clears it.
function toggleView(id: string) {
  selectView(selectedViewId.value === id ? null : id)
}

// ---- New calendars ----------------------------------------------------------------------------

const caldav = useCalDav()
// The calendar view loads its sources again when this changes, and then lists the new calendar.
const sourcesVersion = useCalendarSourcesVersion()
// A calendar is made in the person's own home; without a calendar service (demo) there is none.
const canCreateCalendars = live && caldav !== null

/** Makes a calendar in the person's own home. Returns what is wrong, or nothing when it was made. */
async function submitCalendar(name: string): Promise<string | undefined> {
  if (!caldav) return undefined
  const problem = calendarNameProblem(name)
  if (problem) return problem
  // Two calendars of one name cannot be told apart in the lists, which is what this avoids.
  const taken = regularCalendars.value.some(
    (calendar) => calendar.name.toLowerCase() === name.toLowerCase(),
  )
  if (taken) return t('A calendar with this name already exists.')
  try {
    await caldav.client.createCalendar({ displayName: name })
  } catch (error) {
    return t('The calendar could not be created: {problem}', {
      problem: describeLoadError(error),
    })
  }
  sourcesVersion.value++
  return undefined
}

function submitCategory(name: string) {
  return addCategory(name) ? undefined : t('A category with this name already exists.')
}

function submitFilter(text: string) {
  return addFilter(text) ? undefined : t('A filter with this name already exists.')
}
</script>
