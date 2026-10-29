import type { ResourceType, ViewIcon } from '../../shared/types/calendar'

// Literal names so the icon collection can be bundled at build time (lucide via Nuxt Icon).
const VIEW_ICONS = {
  calendar: 'i-lucide-calendar',
  users: 'i-lucide-users',
  layers: 'i-lucide-layers',
  shield: 'i-lucide-shield',
  star: 'i-lucide-star',
} satisfies Record<ViewIcon, string>

const RESOURCE_ICONS = {
  room: 'i-lucide-door-open',
  car: 'i-lucide-car',
  equipment: 'i-lucide-wrench',
} satisfies Record<ResourceType, string>

export function viewIconName(icon: ViewIcon): string {
  return VIEW_ICONS[icon]
}

export function resourceIconName(type: ResourceType): string {
  return RESOURCE_ICONS[type]
}
