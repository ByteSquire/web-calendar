<!--
  The rules of one calendar (FR-14): who, what they may do and whether the calendar server has the
  rule yet. "Pending" is a word, not only a colour. Each Remove button names the rule it removes.
-->
<template>
  <ul
    v-if="rules.length > 0"
    :aria-label="`Access rules of ${calendarName}`"
    class="flex flex-col gap-2"
  >
    <li
      v-for="rule in rules"
      :key="rule.id"
      data-access-rule
      class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
    >
      <UIcon :name="iconFor(rule.principalType)" class="size-5 shrink-0" aria-hidden="true" />
      <div class="min-w-0 flex-1 basis-48">
        <p class="font-medium wrap-anywhere">{{ rule.label }}</p>
        <p class="text-sm text-toned">
          {{ principalKind(rule.principalType) }} · {{ levelLabel(rule.permission) }}
        </p>
      </div>
      <UBadge
        :label="rule.applied ? 'Applied' : 'Pending'"
        :icon="rule.applied ? 'i-lucide-check' : 'i-lucide-clock'"
        color="neutral"
        variant="outline"
        :title="
          rule.applied
            ? 'The calendar server has this rule.'
            : 'Saved, but the calendar server does not have it yet.'
        "
      />
      <UButton
        :aria-label="`Remove ${rule.label} from ${calendarName}`"
        icon="i-lucide-trash-2"
        label="Remove"
        color="neutral"
        variant="outline"
        :disabled="busy"
        @click="emit('remove', rule)"
      />
    </li>
  </ul>
  <p v-else data-access-empty class="text-toned">
    Nobody else has access to {{ calendarName }}. Only the owner can see it.
  </p>
</template>

<script setup lang="ts">
import {
  levelLabel,
  principalKind,
  type AccessPrincipalType,
  type AccessRule,
} from '~/utils/admin/access'

defineProps<{ rules: readonly AccessRule[]; calendarName: string; busy: boolean }>()
const emit = defineEmits<{ remove: [rule: AccessRule] }>()

function iconFor(type: AccessPrincipalType): string {
  return type === 'user' ? 'i-lucide-user' : type === 'group' ? 'i-lucide-users' : 'i-lucide-globe'
}
</script>
