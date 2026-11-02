<!--
  Sidebar body (FR-21): views, calendars, resources, categories, filters, all from the shared
  calendar state. Rendered inside the desktop column and inside the mobile slideover.
-->
<template>
  <div class="flex flex-col gap-3 p-2">
    <SidebarProblems />

    <SidebarSection title="Views">
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
          />
        </li>
      </ul>
      <SidebarAddInput noun="view" :submit="submitOwnView" />
      <SidebarAddInput v-if="isAdmin" noun="shared view" :submit="submitSharedView" />
    </SidebarSection>

    <SidebarSection title="Calendars">
      <ul>
        <li v-for="calendar in regularCalendars" :key="calendar.id">
          <SidebarToggleRow
            :label="calendar.name"
            :color="calendar.color"
            :model-value="visibleCalendarIds.includes(calendar.id)"
            @update:model-value="setCalendarVisible(calendar.id, $event)"
          />
        </li>
      </ul>
    </SidebarSection>

    <SidebarSection title="Resources">
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
        Resource bookings
      </NuxtLink>
    </SidebarSection>

    <SidebarSection title="Categories">
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
      <SidebarAddInput noun="category" :submit="submitCategory" />
    </SidebarSection>

    <SidebarSection title="Filters">
      <ul>
        <li v-for="filter in filters" :key="filter.id">
          <SidebarToggleRow
            :label="filter.name"
            :model-value="activeFilterIds.includes(filter.id)"
            @update:model-value="setFilterActive(filter.id, $event)"
          />
        </li>
      </ul>
      <SidebarAddInput noun="filter" :submit="submitFilter" />
    </SidebarSection>

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
          ? 'The shared view disappears for everybody.'
          : 'Only this view is deleted; the calendars stay.'
      "
      :pending="pending"
      :error="dialogError"
      @update:open="closeDialogs"
      @confirm="confirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { useAuthFetch } from '~/composables/useAuthFetch'
import { useServerConfigState } from '~/composables/useServerConfigState'
import {
  createSharedView,
  deleteSharedView,
  describeSharedViewError,
  fetchIsAdmin,
  sharedViewBody,
  updateSharedView,
  type AdminViewsApi,
} from '~/utils/live/admin-views'
import { isLiveConfig } from '~/utils/live/seed'
import {
  copyName,
  createOwnView,
  deleteOwnView,
  describeOwnViewError,
  ownViewBody,
  updateOwnView,
} from '~/utils/live/user-views'
import type { CalendarView, ViewIcon } from '../../shared/types/calendar'

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

async function submitSharedView(name: string): Promise<string | undefined> {
  if (views.value.some((view) => view.isAdmin && view.name === name)) {
    return 'A shared view with this name already exists.'
  }
  try {
    const body = sharedViewBody(name, 'users', visibleCalendarIds.value)
    if (api) {
      views.value = [...views.value, await createSharedView(api, body)]
    } else {
      localCounter += 1
      views.value = [
        ...views.value,
        {
          id: `view-shared-${localCounter}`,
          name,
          icon: 'users',
          calendarIds: body.calendars.map((calendar) => calendar.ref),
          isAdmin: true,
        },
      ]
    }
    return undefined
  } catch (error) {
    return describeSharedViewError(error)
  }
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
  if (ownNames().includes(name)) return 'A view with this name already exists.'
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
    toast.add({ title: `Added ${created.name} to your views`, icon: 'i-lucide-check' })
  } catch (error) {
    toast.add({ title: describeOwnViewError(error), color: 'error', icon: 'i-lucide-x' })
  }
}

async function updateFromSelection(view: CalendarView) {
  try {
    const body = sharedViewBody(view.name, view.icon, visibleCalendarIds.value)
    const next = api
      ? await updateSharedView(api, view.id, body)
      : { ...view, calendarIds: body.calendars.map((calendar) => calendar.ref) }
    replaceView(next)
    toast.add({ title: `Updated shared view ${view.name}`, icon: 'i-lucide-check' })
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

// Selecting the active view again clears it.
function toggleView(id: string) {
  selectView(selectedViewId.value === id ? null : id)
}

function submitCategory(name: string) {
  return addCategory(name) ? undefined : 'A category with this name already exists.'
}

function submitFilter(text: string) {
  return addFilter(text) ? undefined : 'A filter with this name already exists.'
}
</script>
