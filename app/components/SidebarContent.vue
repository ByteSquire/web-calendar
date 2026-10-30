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
            @select="toggleView(view.id)"
          />
        </li>
      </ul>
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
  </div>
</template>

<script setup lang="ts">
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
