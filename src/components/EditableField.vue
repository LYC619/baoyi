<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    label?: string
    placeholder?: string
    multiline?: boolean
    mono?: boolean
  }>(),
  { label: '', placeholder: '', multiline: false, mono: false }
)

const emit = defineEmits<{ (e: 'commit', value: string): void }>()

const draft = ref(props.modelValue)
watch(
  () => props.modelValue,
  (v) => {
    if (v !== draft.value) draft.value = v
  }
)

const dirty = computed(() => draft.value !== props.modelValue)

/** 失焦才提交，避免每敲一个字就打一次库 */
function commit(): void {
  if (dirty.value) emit('commit', draft.value)
}
</script>

<template>
  <label class="field">
    <span v-if="label" class="field__label">{{ label }}</span>
    <textarea
      v-if="multiline"
      v-model="draft"
      class="textarea"
      :class="{ mono }"
      :placeholder="placeholder"
      spellcheck="false"
      @blur="commit"
    />
    <input
      v-else
      v-model="draft"
      class="input"
      :class="{ mono }"
      :placeholder="placeholder"
      spellcheck="false"
      @blur="commit"
      @keydown.enter="($event.target as HTMLInputElement).blur()"
    />
  </label>
</template>
