<!--
  "Book right away" (design section 5): checked, saving the event also asks for its resources;
  unchecked, the event is saved as a draft that books nothing. Sits beside the save button.
-->
<template>
  <UCheckbox
    :model-value="modelValue"
    label="Book right away"
    :disabled="disabled"
    :ui="{ root: 'relative min-h-11 items-center', base: 'before:absolute before:inset-0' }"
    @update:model-value="emit('update:modelValue', $event === true)"
  />
</template>

<script setup lang="ts">
defineProps<{ modelValue: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>
