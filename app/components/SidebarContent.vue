<!--
  Sidebar body (FR-21): views, calendars, resources, categories, filters, all from the shared
  calendar state. Rendered inside the desktop column and inside the mobile slideover. The sections
  come in the order the person keeps them in (saved for the account). They are dragged by their
  headings (a long press first on a touch screen); the list with arrow buttons that arranges them
  without dragging replaces the sections until it is closed.
  "Hide" in an item's menu switches it off and moves it into the "Hidden" section, always the last
  (useSidebarHidden.ts, saved for the account): there it shows the icon of its kind instead of its
  colour, and an open eye that puts it back in its section, still off.
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
          add-dialog
          @add="startAddView"
        >
          <ul>
            <li v-for="view in shownViews" :key="view.id" :data-sidebar-item="`view:${view.id}`">
              <SidebarViewItem
                :view="view"
                :selected="view.id === selectedViewId"
                :can-manage="isAdmin"
                @select="toggleView(view.id)"
                @edit="startEditView(view)"
                @update="updateFromSelection(view)"
                @delete="startDelete(view)"
                @copy="copyView(view)"
                @share="shareView(view)"
                @unshare="unshareSharedView(view)"
                @hide="hideFromSidebar('view', view.id)"
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
              v-for="calendar in shownCalendars"
              :key="calendar.id"
              :data-sidebar-item="`calendar:${calendar.id}`"
              class="flex items-center gap-1"
            >
              <SidebarToggleRow
                class="min-w-0 flex-1"
                :label="calendar.name"
                :color="calendar.color"
                :model-value="visibleCalendarIds.includes(calendar.id)"
                @update:model-value="setCalendarVisible(calendar.id, $event)"
              />
              <SidebarRowMenu
                :label="t('Actions for calendar {name}', { name: calendar.name })"
                :items="calendarItems(calendar)"
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
            <li
              v-for="resource in shownResources"
              :key="resource.id"
              :data-sidebar-item="`resource:${resource.id}`"
              class="flex items-center gap-1"
            >
              <SidebarToggleRow
                class="min-w-0 flex-1"
                :label="resource.name"
                :icon="resourceIconName(resource.type)"
                :color="calendarById.get(resource.calendarId)?.color"
                :model-value="visibleResourceIds.includes(resource.id)"
                @update:model-value="setResourceVisible(resource.id, $event)"
              />
              <SidebarRowMenu
                :label="t('Actions for resource {name}', { name: resource.name })"
                :items="resourceItems(resource)"
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
            <li
              v-for="category in shownCategories"
              :key="category.id"
              :data-sidebar-item="`category:${category.id}`"
              class="flex items-center gap-1"
            >
              <SidebarToggleRow
                class="min-w-0 flex-1"
                :label="category.name"
                :color="category.color"
                :model-value="selectedCategoryIds.includes(category.id)"
                @update:model-value="setCategorySelected(category.id, $event)"
              />
              <SidebarRowMenu
                :label="t('Actions for category {name}', { name: category.name })"
                :items="categoryItems(category)"
              />
            </li>
          </ul>
        </SidebarSection>

        <SidebarSection
          v-else-if="id === 'filters'"
          :data-section-id="id"
          :title="SECTION_TITLES.filters"
          add-noun="filter"
          add-dialog
          @add="startAddFilter"
        >
          <ul>
            <li
              v-for="filter in shownFilters"
              :key="filter.id"
              :data-sidebar-item="`filter:${filter.id}`"
              class="flex items-center gap-1"
            >
              <SidebarToggleRow
                class="min-w-0 flex-1"
                :label="filter.name"
                :icon="filterIcon(filter.kind)"
                :model-value="activeFilterIds.includes(filter.id)"
                @update:model-value="setFilterActive(filter.id, $event)"
              />
              <SidebarRowMenu
                :label="t('Actions for filter {name}', { name: filter.name })"
                :items="filterItems(filter)"
              />
            </li>
          </ul>
        </SidebarSection>
      </template>

      <!-- Not one of the arranged sections: no data-section-id, so it is never dragged. -->
      <SidebarSection
        v-if="hiddenRows.length > 0"
        :title="HIDDEN_SECTION_TITLE"
        fixed
        data-hidden-section
      >
        <ul>
          <li
            v-for="row in hiddenRows"
            :key="row.key"
            :data-hidden-item="row.key"
            class="flex min-h-11 items-center gap-2 ps-2"
          >
            <UIcon :name="row.icon" class="size-4 shrink-0 text-muted" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-muted">{{ row.name }}</span>
            <UButton
              icon="i-lucide-eye"
              color="neutral"
              variant="ghost"
              square
              class="min-h-11 min-w-11 shrink-0 justify-center"
              :aria-label="row.unhideLabel"
              :title="row.unhideLabel"
              @click="unhideInSidebar(row.kind, row.id)"
            />
          </li>
        </ul>
      </SidebarSection>

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

    <ViewDialog
      :open="viewDialog !== null"
      :mode="viewDialog?.view ? 'edit' : 'add'"
      :shared="viewDialogShared"
      :initial-name="viewDialog?.view?.name ?? ''"
      :initial-ids="viewDialog?.view?.calendarIds ?? visibleCalendarIds"
      :calendars="viewDialogCalendars"
      :hidden-count="viewDialogHidden"
      :taken-names="viewDialogTaken"
      :pending="pending"
      :error="dialogError"
      :return-focus-to="viewDialog?.returnFocusTo ?? null"
      @update:open="(open: boolean) => !open && closeViewDialog()"
      @save="saveView"
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
    <template v-if="live">
      <AdminCalendarDialog
        v-model:tab="editCalendarTab"
        :access="adminAccess"
        :calendar-id="editCalendarId"
        @close="editCalendarId = null"
      />
      <GroupsCalendarDialog
        :target="editGroupCalendar"
        @close="editGroupCalendar = null"
        @deleted="(message: string) => toast.add({ title: message, icon: 'i-lucide-check' })"
      />
      <AdminResourceDialog
        v-model:tab="editResourceTab"
        :resource="editResource"
        :users="resourceUsers"
        :groups="resourceGroups"
        @close="editResource = null"
        @saved="(saved: AdminResource) => (editResource = saved)"
      />
    </template>
    <CategoryEventsDialog
      :category="statusTarget ?? deleteTarget"
      :mode="deleteTarget ? 'delete' : 'status'"
      @close="closeCategoryEvents"
    />
    <FilterDialog
      :open="filterDialog !== null"
      :filter="filterDialog?.filter ?? null"
      :filters="filters"
      :categories="categories"
      :known-people="knownFilterPeople"
      :pending="itemPending"
      :error="itemError"
      :return-focus-to="filterDialog?.returnFocusTo ?? null"
      @update:open="(open: boolean) => !open && closeItemDialogs()"
      @save="saveFilter"
    />
    <RenameDialog
      :open="itemRename !== null"
      :title="renameTitle"
      :description="renameDescription"
      :value="itemRename?.item.name ?? ''"
      :pending="itemPending"
      :error="itemError"
      @update:open="(open: boolean) => !open && closeItemDialogs()"
      @save="saveItemRename"
    />
    <ColorDialog
      :open="categoryColor !== null"
      :title="t('Colour of {name}', { name: categoryColor?.name ?? '' })"
      :description="categoryColorDescription"
      :choices="[...COLOR_PALETTE]"
      :value="categoryColor?.color.toLowerCase() ?? ''"
      :pending="itemPending"
      :error="itemError || null"
      @close="closeItemDialogs"
      @save="saveCategoryColor"
    />
    <ConfirmDeleteDialog
      :open="itemDelete !== null"
      :event-title="itemDelete?.item.name ?? ''"
      :detail="deleteDetail"
      :pending="itemPending"
      :error="itemError"
      @update:open="(open: boolean) => !open && closeItemDialogs()"
      @confirm="confirmItemDelete"
    />
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
import { filterIcon, knownPeople, type FilterDraft } from '~/utils/filters'
import { N_, t, tv } from '~/utils/i18n'
import { HIDDEN_SECTION_TITLE, SECTION_TITLES } from '~/utils/sidebar-sections'
import { useSidebarHidden } from '~/composables/useSidebarHidden'
import type { SidebarHiddenKind } from '../../shared/utils/sidebar-hidden'
import type { SidebarSectionId } from '../../shared/utils/sidebar-sections'
import {
  chosenViewCalendarIds,
  hiddenViewCalendarCount,
  offeredViewCalendars,
  takenViewNames,
} from '~/utils/view-form'
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
import type { DropdownMenuItem } from '@nuxt/ui'
import { useAdminAccess } from '~/composables/useAdminAccess'
import { linkedCalendar, type AccessUser } from '~/utils/admin/access'
import type { AdminResource } from '~/utils/admin/resources'
import { serverCalendarOf } from '~/utils/live/calendars'
import { isAutoCategory } from '~/utils/live/categories'
import { describeError } from '~/utils/settings/api-errors'
import { COLOR_PALETTE } from '~/utils/settings/palette'
import type {
  Calendar,
  CalendarFilter,
  CalendarResource,
  CalendarView,
  Category,
  ViewIcon,
} from '../../shared/types/calendar'

const {
  views,
  selectedViewId,
  selectView,
  calendars,
  events,
  regularCalendars,
  calendarById,
  visibleCalendarIds,
  setCalendarVisible,
  renameCalendar,
  deleteCalendar,
  resources,
  visibleResourceIds,
  setResourceVisible,
  categories,
  selectedCategoryIds,
  setCategorySelected,
  addCategory,
  updateCategory,
  colorCategory,
  deleteCategory,
  filters,
  activeFilterIds,
  setFilterActive,
  addFilter,
  updateFilter,
  deleteFilter,
  savingIds,
} = useCalendarState()

/** The calendar whose colour dialog is open. */
const colorTarget = ref<Calendar | null>(null)

// ---- Hidden items (useSidebarHidden.ts) --------------------------------------------------------
// A hidden item leaves its section for "Hidden", where it has the icon of its kind (its colour does
// not matter there) and an open eye that puts it back. The icons differ from the ones a view may
// choose and from the filters' (a calendar has days on it, a category is a bookmark); a view keeps
// its own icon, a resource its room, car or tool. The eye is named after the kind and the name,
// so a screen reader tells a calendar from a filter of the same name.

const sidebarHidden = useSidebarHidden()
const shownViews = computed(() => views.value.filter((v) => !sidebarHidden.isHidden('view', v.id)))
const shownCalendars = computed(() =>
  regularCalendars.value.filter((c) => !sidebarHidden.isHidden('calendar', c.id)),
)
const shownResources = computed(() =>
  resources.value.filter((r) => !sidebarHidden.isHidden('resource', r.id)),
)
const shownCategories = computed(() =>
  categories.value.filter((c) => !sidebarHidden.isHidden('category', c.id)),
)
const shownFilters = computed(() =>
  filters.value.filter((f) => !sidebarHidden.isHidden('filter', f.id)),
)

const UNHIDE_LABELS: Record<SidebarHiddenKind, string> = {
  view: N_('Unhide view {name}'),
  calendar: N_('Unhide calendar {name}'),
  resource: N_('Unhide resource {name}'),
  category: N_('Unhide category {name}'),
  filter: N_('Unhide filter {name}'),
}

interface HiddenRow {
  key: string
  kind: SidebarHiddenKind
  id: string
  name: string
  icon: string
  unhideLabel: string
}

/** The hidden items, in the order of the sections they come from, each section in its own order. */
const hiddenRows = computed<HiddenRow[]>(() => {
  const row = (kind: SidebarHiddenKind, id: string, name: string, icon: string): HiddenRow => ({
    key: `${kind}:${id}`,
    kind,
    id,
    name,
    icon,
    unhideLabel: tv(UNHIDE_LABELS[kind], { name }),
  })
  const of: Record<SidebarSectionId, () => HiddenRow[]> = {
    views: () =>
      views.value
        .filter((v) => sidebarHidden.isHidden('view', v.id))
        .map((v) => row('view', v.id, v.name, viewIconName(v.icon))),
    calendars: () =>
      regularCalendars.value
        .filter((c) => sidebarHidden.isHidden('calendar', c.id))
        .map((c) => row('calendar', c.id, c.name, 'i-lucide-calendar-days')),
    resources: () =>
      resources.value
        .filter((r) => sidebarHidden.isHidden('resource', r.id))
        .map((r) => row('resource', r.id, r.name, resourceIconName(r.type))),
    categories: () =>
      categories.value
        .filter((c) => sidebarHidden.isHidden('category', c.id))
        .map((c) => row('category', c.id, c.name, 'i-lucide-bookmark')),
    filters: () =>
      filters.value
        .filter((f) => sidebarHidden.isHidden('filter', f.id))
        .map((f) => row('filter', f.id, f.name, filterIcon(f.kind))),
  }
  return order.value.flatMap((id) => of[id]())
})

/** "Hide" in the menu of an item. */
function hideItem(kind: SidebarHiddenKind, id: string, disabled = false): DropdownMenuItem {
  return {
    label: t('Hide'),
    icon: 'i-lucide-eye-off',
    disabled,
    onSelect: () => hideFromSidebar(kind, id),
  }
}

/**
 * Focuses what `selector` finds once the menu that chose an item has closed. The menu would give
 * the focus back to its button, and the row with that button is gone: the focus goes where the
 * item went instead.
 */
function focusWhenMenuCloses(selectors: string[]) {
  let frames = 0
  const attempt = () => {
    frames += 1
    if (document.querySelector('[role="menu"]') === null) {
      const target = selectors
        .map((selector) => root.value?.querySelector<HTMLElement>(selector))
        .find((element) => element && element.getClientRects().length > 0)
      if (target) {
        target.focus()
        return
      }
    }
    if (frames < 60) requestAnimationFrame(attempt)
  }
  void nextTick(() => requestAnimationFrame(attempt))
}

function hideFromSidebar(kind: SidebarHiddenKind, id: string) {
  sidebarHidden.hide(kind, id)
  // To its eye in "Hidden", so that it can be put back at once; with "Hidden" folded, its heading.
  focusWhenMenuCloses([
    `[data-hidden-item="${CSS.escape(`${kind}:${id}`)}"] button`,
    '[data-hidden-section] h2 button',
  ])
}

function unhideInSidebar(kind: SidebarHiddenKind, id: string) {
  const key = `${kind}:${id}`
  const next = hiddenRows.value[hiddenRows.value.findIndex((row) => row.key === key) + 1]
  sidebarHidden.show(kind, id)
  // To the item's menu, back in its section; where that section is folded away, to the next hidden
  // item's eye, and when none is left, to "Arrange sections".
  void nextTick(() => {
    const visible = (element: HTMLElement | null | undefined) =>
      element && element.getClientRects().length > 0 ? element : null
    const back = [
      ...(root.value?.querySelectorAll<HTMLElement>(
        `[data-sidebar-item="${CSS.escape(key)}"] button`,
      ) ?? []),
    ].at(-1)
    const nextEye = next
      ? root.value?.querySelector<HTMLElement>(
          `[data-hidden-item="${CSS.escape(next.key)}"] button`,
        )
      : null
    ;(visible(back) ?? visible(nextEye) ?? arrangeButton.value?.$el)?.focus()
  })
}

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

// ---- The view dialog --------------------------------------------------------------------------
// The plus of the views section adds a view, Edit in a view's menu changes one: its name and the
// calendars it groups (ViewDialog). A new view starts with the calendars switched on now, and is
// selected once it is made, so that it shows what it groups. Calendars of a view that the dialog
// does not offer (the viewer cannot see them) stay in it.

/** The view dialog: adding (`view` null) or changing a view, and where the focus goes after. */
const viewDialog = ref<{
  view: CalendarView | null
  returnFocusTo: HTMLElement | null
} | null>(null)
const viewDialogShared = computed(() => viewDialog.value?.view?.isAdmin ?? false)
const viewDialogCalendars = computed(() =>
  offeredViewCalendars(regularCalendars.value, viewDialogShared.value),
)
const viewDialogHidden = computed(() => {
  const view = viewDialog.value?.view
  return view ? hiddenViewCalendarCount(view.calendarIds, viewDialogCalendars.value) : 0
})
const viewDialogTaken = computed(() =>
  takenViewNames(views.value, viewDialogShared.value, viewDialog.value?.view?.id),
)

function startAddView(plus: HTMLElement) {
  dialogError.value = ''
  viewDialog.value = { view: null, returnFocusTo: plus }
}

function startEditView(view: CalendarView) {
  dialogError.value = ''
  viewDialog.value = { view, returnFocusTo: null }
}

function closeViewDialog() {
  if (!pending.value) viewDialog.value = null
}

async function saveView(draft: { name: string; calendarIds: string[] }) {
  const target = viewDialog.value
  if (!target || pending.value) return
  const view = target.view
  pending.value = true
  dialogError.value = ''
  try {
    if (!view) {
      const created = await createOwn(draft.name, 'calendar', draft.calendarIds)
      views.value = [...views.value, created]
      selectView(created.id)
    } else {
      const requests = requestsFor(view)
      const ids = chosenViewCalendarIds(
        view.calendarIds,
        viewDialogCalendars.value,
        draft.calendarIds,
      )
      const body = requests.body(draft.name, view.icon, ids)
      replaceView(
        api
          ? await requests.update(api, view.id, body)
          : { ...view, name: draft.name, calendarIds: body.calendars.map((item) => item.ref) },
      )
      // A selected view shows its calendars as they are now.
      if (selectedViewId.value === view.id) selectView(view.id)
    }
    viewDialog.value = null
  } catch (error) {
    dialogError.value = view ? requestsFor(view).describe(error) : describeOwnViewError(error)
  } finally {
    pending.value = false
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

/**
 * "Update from selection": the view groups the calendars switched on now (of those it can hold;
 * calendars of it the viewer cannot see stay). Refused while none of them is on.
 */
async function updateFromSelection(view: CalendarView) {
  const offered = offeredViewCalendars(regularCalendars.value, view.isAdmin)
  const visible = new Set(visibleCalendarIds.value)
  const chosen = offered.filter((calendar) => visible.has(calendar.id)).map((item) => item.id)
  if (chosen.length === 0) {
    toast.add({
      title: t('Choose at least one calendar first.'),
      color: 'error',
      icon: 'i-lucide-x',
    })
    return
  }
  const requests = requestsFor(view)
  try {
    const body = requests.body(
      view.name,
      view.icon,
      chosenViewCalendarIds(view.calendarIds, offered, chosen),
    )
    replaceView(
      api
        ? await requests.update(api, view.id, body)
        : { ...view, calendarIds: body.calendars.map((calendar) => calendar.ref) },
    )
    toast.add({
      title: view.isAdmin
        ? t('Updated shared view {name}', { name: view.name })
        : t('Updated view {name}', { name: view.name }),
      icon: 'i-lucide-check',
    })
  } catch (error) {
    toast.add({ title: requests.describe(error), color: 'error', icon: 'i-lucide-x' })
  }
}

function startDelete(view: CalendarView) {
  dialogError.value = ''
  deleting.value = view
}

function closeDialogs() {
  deleting.value = null
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

// ---- The menus of calendars, categories and filters --------------------------------------------
// Each row offers what the viewer may do with it (the server checks again): every calendar its
// colour for the viewer, and "Edit calendar" where they may manage it, in a dialog right here (for
// an admin the one of Admin › Calendars, for a manager of its group the one of a group calendar); a calendar of their own, or of a group they manage, Rename and Delete too
// (their default calendar Rename only: it is kept, so there is always one to write to)
// (an admin changes everybody's on Admin › Calendars, not here); a category of their own, or a
// shared one for an admin, Rename, Colour and Delete; every resource its colour for the viewer and,
// for an admin, "Edit resource" (the dialog of Admin › Resources, right here); every filter (filters are always one's own)
// Edit (the filter dialog: name, kind, value and mode) and Delete. A category that only events
// carry is a name, not a row: it offers Colour, which saves it as a category of that colour (it has no row to rename or delete; renaming it would mean
// changing the events). Where there is a calendar service, every category also offers "Turn into a
// status…": its events get a status instead, and Delete takes the category off the events too (both
// CategoryEventsDialog; without it a deleted category came back as a name its events carry). A new category can be
// changed once the server has saved it; a new filter is listed only then.

type Item =
  | { kind: 'calendar'; item: Calendar }
  | { kind: 'category'; item: Category }
  | { kind: 'filter'; item: CalendarFilter }

const itemRename = ref<Item | null>(null)
/** The filter dialog: adding (`filter` null) or changing a filter, and where the focus goes after. */
const filterDialog = ref<{
  filter: CalendarFilter | null
  returnFocusTo: HTMLElement | null
} | null>(null)
/** The people the list of a person filter offers; worked out while the filter dialog is open. */
const knownFilterPeople = computed(() =>
  filterDialog.value
    ? knownPeople(
        events.value,
        calendars.value.flatMap((calendar) => (calendar.ownerName ? [calendar.ownerName] : [])),
      )
    : [],
)
/** The category whose "Turn into a status" dialog is open, or whose delete dialog. */
const statusTarget = ref<Category | null>(null)
const deleteTarget = ref<Category | null>(null)

function closeCategoryEvents() {
  statusTarget.value = null
  deleteTarget.value = null
}
const itemDelete = ref<Item | null>(null)
const categoryColor = ref<Category | null>(null)
const itemPending = ref(false)
const itemError = ref('')

/** What the colour dialog of a category says: who sees it, or that a name is saved. */
const categoryColorDescription = computed(() => {
  const category = categoryColor.value
  if (!category) return undefined
  if (isAutoCategory(category)) {
    return t('{name} is saved as one of your categories, with this colour.', {
      name: category.name,
    })
  }
  return category.shared ? t('Everybody sees this colour.') : undefined
})

const mayChangeCategory = (category: Category) =>
  isAutoCategory(category) || !category.shared || isAdmin.value

function startItemRename(item: Item) {
  itemError.value = ''
  itemRename.value = item
}

function startItemDelete(item: Item) {
  itemError.value = ''
  itemDelete.value = item
}

function closeItemDialogs() {
  if (itemPending.value) return
  itemRename.value = null
  itemDelete.value = null
  categoryColor.value = null
  filterDialog.value = null
}

function startAddFilter(plus: HTMLElement) {
  itemError.value = ''
  filterDialog.value = { filter: null, returnFocusTo: plus }
}

function startEditFilter(filter: CalendarFilter) {
  itemError.value = ''
  filterDialog.value = { filter, returnFocusTo: null }
}

/** Adds the filter of the dialog (and switches it on) or saves the change. */
async function saveFilter(draft: FilterDraft) {
  const target = filterDialog.value
  if (!target || itemPending.value) return
  const filter = target.filter
  await runItemChange(
    async () => {
      const done = filter ? await updateFilter(filter.id, draft) : (await addFilter(draft)) !== null
      return done ? null : t('A filter with this name already exists.')
    },
    filter ? N_('change the filter') : N_('add the filter'),
  )
}

/** Rename and Delete, made here while rendering so that the labels follow a change of language. */
function renameAndDelete(item: Item, disabled = false) {
  const rename: DropdownMenuItem = {
    label: t('Rename'),
    icon: 'i-lucide-pencil',
    disabled,
    onSelect: () => startItemRename(item),
  }
  const remove: DropdownMenuItem = {
    label: t('Delete'),
    icon: 'i-lucide-trash-2',
    color: 'error',
    disabled,
    onSelect: () => startItemDelete(item),
  }
  return { rename, remove }
}

function calendarItems(calendar: Calendar): DropdownMenuItem[][] {
  const colour: DropdownMenuItem = {
    label: t('Colour'),
    icon: 'i-lucide-palette',
    onSelect: () => {
      colorTarget.value = calendar
    },
  }
  const edit = editCalendarItem(calendar)
  const hide = hideItem('calendar', calendar.id)
  if (!calendar.manage) return [[colour, ...edit, hide]]
  const { rename, remove } = renameAndDelete({ kind: 'calendar', item: calendar })
  if (calendar.manage.kind === 'own' && calendar.manage.default) {
    return [[rename, colour, ...edit, hide]]
  }
  return [[rename, colour, ...edit, hide], [remove]]
}

/**
 * "Edit calendar", for those who may manage the calendar (the routes check again), in a dialog
 * right here, so nobody leaves the calendar: an admin gets the one of Admin › Calendars, for any
 * calendar of the server; a manager of a group the one of a group calendar (name, colour,
 * sharing, delete). Anybody else has none: the owner of a calendar renames and recolours it in
 * this menu.
 */
function editCalendarItem(calendar: Calendar): DropdownMenuItem[] {
  if (!live || !calendar.id.startsWith('dav:') || !calendar.href) return []
  const item = { label: t('Edit calendar'), icon: 'i-lucide-settings-2' }
  const server = isAdmin.value ? serverCalendarOf(calendar.href) : null
  if (server) return [{ ...item, onSelect: () => void openCalendarEditor(server) }]
  const manage = calendar.manage
  if (manage?.kind === 'group') {
    return [
      {
        ...item,
        onSelect: () => {
          editGroupCalendar.value = {
            groupId: manage.groupId,
            calendarId: manage.calendarId,
            name: calendar.name,
          }
        },
      },
    ]
  }
  return []
}

// ---- The admin dialogs, opened in place --------------------------------------------------------
// "Edit calendar" and "Edit resource" open the dialogs of Admin › Calendars and Admin › Resources
// over the calendar, so an admin does not leave it. What they show is loaded when one is opened; the
// dialogs toast what their changes came to themselves.

const adminAccess = useAdminAccess()
/** The group calendar whose dialog is open, for a manager of its group. */
const editGroupCalendar = ref<{ groupId: number; calendarId: number; name: string } | null>(null)
const fetchApi = useAuthFetch()
const editCalendarId = ref<number | null>(null)
const editCalendarTab = ref<'details' | 'access'>('details')
const editResource = ref<AdminResource | null>(null)
const editResourceTab = ref<'details' | 'access'>('details')
const resourceUsers = ref<AccessUser[]>([])
const resourceGroups = ref<{ name: string }[]>([])

function notFoundYet(what: string) {
  toast.add({ title: what, color: 'warning', icon: 'i-lucide-triangle-alert' })
}

async function openCalendarEditor(server: { id: number } | { path: string }) {
  await Promise.all([
    adminAccess.calendars.reload(),
    adminAccess.users.reload(),
    adminAccess.groups.reload(),
  ])
  const failure = adminAccess.calendars.error.value
  if (failure) {
    toast.add({ title: failure, color: 'error', icon: 'i-lucide-x' })
    return
  }
  const found = linkedCalendar(
    adminAccess.calendars.data.value?.calendars ?? [],
    'id' in server ? { open: String(server.id) } : { path: server.path },
  )
  // A calendar made minutes ago is known to the server after its next look at the homes.
  if (!found) {
    notFoundYet(t('This calendar is not known to the server yet. Try again in a few minutes.'))
    return
  }
  editCalendarTab.value = 'details'
  editCalendarId.value = found.id
}

async function openResourceEditor(id: string) {
  try {
    const [list, people, known] = await Promise.all([
      fetchApi<{ resources: AdminResource[] }>('/api/admin/resources'),
      fetchApi<{ users: AccessUser[] }>('/api/admin/access/users').catch(() => ({ users: [] })),
      fetchApi<{ groups: { name: string }[] }>('/api/groups').catch(() => ({ groups: [] })),
    ])
    resourceUsers.value = people.users
    resourceGroups.value = known.groups
    const found = list.resources.find((resource) => String(resource.id) === id)
    if (!found) {
      notFoundYet(t('This resource no longer exists. Reload the page.'))
      return
    }
    editResourceTab.value = 'details'
    editResource.value = found
  } catch (cause) {
    toast.add({
      title: describeError(cause, N_('load the resources')),
      color: 'error',
      icon: 'i-lucide-x',
    })
  }
}

function categoryItems(category: Category): DropdownMenuItem[][] {
  const disabled = savingIds.value.includes(category.id)
  // Not while a new category is saved: its id is about to change, and the hidden key with it.
  const hide = hideItem('category', category.id, disabled)
  // Everybody may hide a category; changing a shared one is for administrators.
  if (!mayChangeCategory(category)) return [[hide]]
  const { rename, remove } = renameAndDelete({ kind: 'category', item: category }, disabled)
  const colour: DropdownMenuItem = {
    label: t('Colour'),
    icon: 'i-lucide-palette',
    disabled,
    onSelect: () => {
      itemError.value = ''
      categoryColor.value = category
    },
  }
  // Turning it into a status rewrites events in CalDAV, so only where there is a calendar service.
  const toStatus: DropdownMenuItem[] = canCreateCalendars
    ? [
        {
          label: t('Turn into a status…'),
          icon: 'i-lucide-circle-check',
          disabled,
          onSelect: () => {
            statusTarget.value = category
          },
        },
      ]
    : []
  // With a calendar service, Delete takes the category off the events too (CategoryEventsDialog),
  // so a name only events carry can be deleted as well; without one it deletes the saved category.
  const removeFromEvents: DropdownMenuItem = {
    ...remove,
    onSelect: () => {
      deleteTarget.value = category
    },
  }
  if (isAutoCategory(category)) {
    return canCreateCalendars ? [[colour, ...toStatus, hide], [removeFromEvents]] : [[colour, hide]]
  }
  return [[rename, colour, ...toStatus, hide], [canCreateCalendars ? removeFromEvents : remove]]
}

/**
 * A resource: its colour for the viewer, and for an admin "Edit resource", which opens it on Admin ›
 * Resources (the menu that is there already holds the admin's way in, design §9).
 */
function resourceItems(resource: CalendarResource): DropdownMenuItem[][] {
  const calendar = calendarById.value.get(resource.calendarId)
  // A resource whose calendar is not loaded (yet) has no colour to change, only "Hide".
  const items: DropdownMenuItem[] = calendar
    ? [
        {
          label: t('Colour'),
          icon: 'i-lucide-palette',
          onSelect: () => {
            colorTarget.value = calendar
          },
        },
      ]
    : []
  if (live && isAdmin.value) {
    items.push({
      label: t('Edit resource'),
      icon: 'i-lucide-pencil',
      onSelect: () => void openResourceEditor(resource.id),
    })
  }
  items.push(hideItem('resource', resource.id))
  return [items]
}

function filterItems(filter: CalendarFilter): DropdownMenuItem[][] {
  const { remove } = renameAndDelete({ kind: 'filter', item: filter })
  const edit: DropdownMenuItem = {
    label: t('Edit'),
    icon: 'i-lucide-pencil',
    onSelect: () => startEditFilter(filter),
  }
  return [[edit, hideItem('filter', filter.id)], [remove]]
}

const renameTitle = computed(() => {
  const target = itemRename.value
  if (!target) return ''
  const name = target.item.name
  if (target.kind === 'calendar') return t('Rename calendar {name}', { name })
  return t('Rename category {name}', { name })
})

const renameDescription = computed(() => {
  const target = itemRename.value
  if (!target) return undefined
  if (target.kind === 'calendar') {
    return target.item.manage?.kind === 'group'
      ? t('Everybody who has this calendar sees the new name.')
      : t('The calendar keeps its events and whom it is shared with.')
  }
  if (target.kind === 'category') {
    return target.item.shared
      ? t('Everybody sees the new name. Events that have the old name keep it.')
      : t('Events that have the old name keep it.')
  }
  return undefined
})

const deleteDetail = computed(() => {
  const target = itemDelete.value
  if (!target) return ''
  if (target.kind === 'calendar') {
    return target.item.manage?.kind === 'group'
      ? t(
          'The calendar and all its events are deleted for everybody in the group and everybody it is shared with, and its links stop working.',
        )
      : t(
          'The calendar and all its events are deleted, the people it is shared with lose it, and its links stop working.',
        )
  }
  if (target.kind === 'category') {
    return target.item.shared
      ? t('The shared category disappears for everybody. Events keep the category name.')
      : t('Only the category is deleted; events keep the category name.')
  }
  return t('Only this filter is deleted; no event changes.')
})

/** What is wrong with a new calendar name, or null: as when one is made, and not taken. */
function calendarRenameProblem(calendar: Calendar, name: string): string | null {
  const problem = calendarNameProblem(name)
  if (problem) return problem
  const taken = regularCalendars.value.some(
    (other) => other.id !== calendar.id && other.name.toLowerCase() === name.toLowerCase(),
  )
  return taken ? t('A calendar with this name already exists.') : null
}

/** Runs a change of a dialog: closes it when done, keeps it open with the reason when not. */
async function runItemChange(work: () => Promise<string | null>, action: string) {
  itemPending.value = true
  itemError.value = ''
  try {
    const problem = await work()
    itemPending.value = false
    if (problem) itemError.value = problem
    else closeItemDialogs()
  } catch (cause) {
    itemPending.value = false
    itemError.value = describeError(cause, action)
  }
}

async function saveItemRename(name: string) {
  const target = itemRename.value
  if (!target || itemPending.value) return
  if (target.item.name === name) {
    closeItemDialogs()
    return
  }
  if (target.kind === 'calendar') {
    const problem = calendarRenameProblem(target.item, name)
    if (problem) {
      itemError.value = problem
      return
    }
    await runItemChange(async () => {
      await renameCalendar(target.item.id, name)
      return null
    }, N_('rename the calendar'))
  } else if (target.kind === 'category') {
    await runItemChange(
      async () =>
        (await updateCategory(target.item.id, { name }))
          ? null
          : t('A category with this name already exists.'),
      N_('rename the category'),
    )
  }
}

async function saveCategoryColor(color: string) {
  const category = categoryColor.value
  if (!category || itemPending.value) return
  await runItemChange(async () => {
    await colorCategory(category.id, color)
    return null
  }, N_('save the colour'))
}

async function confirmItemDelete() {
  const target = itemDelete.value
  if (!target || itemPending.value) return
  if (target.kind === 'calendar') {
    await runItemChange(async () => {
      await deleteCalendar(target.item.id)
      return null
    }, N_('delete the calendar'))
  } else if (target.kind === 'category') {
    await runItemChange(async () => {
      await deleteCategory(target.item.id)
      return null
    }, N_('delete the category'))
  } else {
    await runItemChange(async () => {
      await deleteFilter(target.item.id)
      return null
    }, N_('delete the filter'))
  }
}
</script>
