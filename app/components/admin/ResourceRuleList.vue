<!--
  The rules of one resource: who and what they may do. Each Remove button names the rule it
  removes. Resource rules take effect at once, so there is no "pending" state as for calendars.
-->
<template>
  <ul
    v-if="rules.length > 0"
    :aria-label="`Access rules of ${resourceName}`"
    class="flex flex-col gap-2"
  >
    <li
      v-for="item in rules"
      :key="`${item.rule.principalType}:${item.rule.principal}`"
      data-resource-rule
      class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
    >
      <UIcon :name="iconFor(item.rule.principalType)" class="size-5 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1 basis-48">
        <p class="font-medium wrap-anywhere">{{ item.label }}</p>
        <p class="text-sm text-toned">
          {{ principalKind(item.rule.principalType) }} · {{ rightLabel(item.rule.right) }}
        </p>
      </div>
      <UButton
        :aria-label="`Remove ${item.label} from ${resourceName}`"
        icon="i-lucide-trash-2"
        label="Remove"
        color="neutral"
        variant="outline"
        :disabled="busy"
        @click="emit('remove', item.rule)"
      />
    </li>
  </ul>
  <p v-else data-resource-empty class="text-toned">Nobody has access to {{ resourceName }}.</p>
</template>

<script setup lang="ts">
import { principalKind, type AccessPrincipalType } from '~/utils/admin/access'
import { rightLabel, type ResourceRule } from '~/utils/admin/resources'

defineProps<{
  rules: readonly { rule: ResourceRule; label: string }[]
  resourceName: string
  busy: boolean
}>()
const emit = defineEmits<{ remove: [rule: ResourceRule] }>()

function iconFor(type: AccessPrincipalType): string {
  return type === 'user' ? 'i-lucide-user' : type === 'group' ? 'i-lucide-users' : 'i-lucide-globe'
}
</script>
