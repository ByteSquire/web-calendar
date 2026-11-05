<!--
  Groups from the identity provider (admins only; the page shows this section to them only, the
  server checks again). The list is what people's sign-ins have shown: a group is a candidate here
  and grants nothing until an admin imports it, after which its members follow each sign-in.

  Why a section of its own (docs/design.md §9, AGENTS.md "UI"): no other screen knows the groups of
  the identity provider, and an admin chooses among them here and nowhere else. The Groups page is
  the existing place; the section is shown to admins only. The parent runs the import and asks
  before stopping one (stopping removes the group's members and the rules that name it).
-->
<template>
  <section aria-labelledby="oidc-groups-heading" class="flex flex-col gap-3" data-oidc-groups>
    <h2 id="oidc-groups-heading" class="text-lg font-semibold">
      {{ t('Groups from your identity provider') }}
    </h2>
    <p class="text-sm text-toned">
      {{
        t(
          'These are the groups your identity provider named when people signed in. A group appears here after one of its members signed in. Import a group to use it here: its members are then added and removed as they sign in.',
        )
      }}
    </p>

    <SettingsErrorAlert v-if="error" :message="error" retryable @retry="emit('reload')" />
    <div v-if="loading && candidates === null" role="status" class="flex flex-col gap-2">
      <span class="sr-only">{{ t('Loading the groups of your identity provider') }}</span>
      <USkeleton class="h-11 w-full max-w-md" aria-hidden="true" />
    </div>

    <p v-if="candidates !== null && candidates.length === 0" class="text-toned" data-oidc-none>
      {{ t('No groups have been seen yet.') }}
    </p>

    <ul
      v-if="candidates !== null && candidates.length > 0"
      :aria-label="t('Groups from your identity provider')"
      class="flex flex-col gap-2"
    >
      <li
        v-for="candidate in candidates"
        :key="candidate.id"
        data-oidc-group
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default p-3"
      >
        <div class="min-w-0 flex-1 basis-48">
          <p class="font-medium wrap-anywhere">{{ candidate.name }}</p>
          <p class="text-sm text-toned" data-oidc-status>{{ candidateStatus(candidate) }}</p>
        </div>
        <UButton
          v-if="candidate.imported"
          :aria-label="t('Stop importing {name}', { name: candidate.name })"
          icon="i-lucide-cloud-off"
          :label="t('Stop importing')"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="emit('stop', candidate)"
        />
        <UButton
          v-else
          :aria-label="t('Import {name}', { name: candidate.name })"
          icon="i-lucide-cloud-download"
          :label="t('Import')"
          color="neutral"
          variant="outline"
          :disabled="busy || candidate.blocked !== null"
          @click="emit('import', candidate)"
        />
      </li>
    </ul>

    <p v-if="truncated" class="text-sm text-toned" data-oidc-truncated>
      {{ t('Only the first groups are shown.') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { t } from '~/utils/i18n'
import { candidateStatus, type OidcCandidate } from '~/utils/groups/model'

defineProps<{
  /** null until the list has loaded. */
  candidates: readonly OidcCandidate[] | null
  truncated: boolean
  loading: boolean
  /** The words for a failed load, or null. */
  error: string | null
  busy: boolean
}>()

const emit = defineEmits<{
  reload: []
  import: [candidate: OidcCandidate]
  stop: [candidate: OidcCandidate]
}>()
</script>
