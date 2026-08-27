<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string
    tone?: 'accent' | 'alt' | 'warning' | 'success' | 'muted'
    clickable?: boolean
  }>(),
  { tone: 'accent', clickable: false }
)

defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <component
    :is="clickable ? 'button' : 'span'"
    class="tag"
    :class="[`tag--${tone}`, { 'tag--clickable': clickable }]"
    @click="clickable && $emit('click')"
  >
    {{ label }}
  </component>
</template>

<style scoped>
.tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-tag);
  font-size: var(--fs-tag);
  line-height: 1;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag--accent {
  background: var(--tag-bg);
  color: var(--tag-text);
}
.tag--alt {
  background: var(--tag-alt-bg);
  color: var(--tag-alt-text);
}
.tag--warning {
  background: var(--warning-bg);
  color: var(--warning);
}
.tag--success {
  background: var(--success-bg);
  color: var(--success);
}
.tag--muted {
  background: var(--hover-surface);
  color: var(--text-sub);
}

.tag--clickable {
  cursor: pointer;
  transition: filter var(--t-fast) ease;
}
.tag--clickable:hover {
  filter: brightness(1.25);
}
</style>
