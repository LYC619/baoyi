<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { displayName, iconUrl, type NamedEntry } from '@/utils'

// 暂存条目（确认面板）和正式条目共用这个组件，所以只要求它真正用到的那几个字段
const props = withDefaults(
  defineProps<{ item: NamedEntry & { icon_path: string }; size?: number }>(),
  { size: 48 }
)

const failed = ref(false)
const src = computed(() => iconUrl(props.item.icon_path))
const initial = computed(() => displayName(props.item).trim().charAt(0) || '?')

// 换了条目要重新给图标一次机会
watch(src, () => (failed.value = false))
</script>

<template>
  <div class="app-icon" :style="{ '--s': `${size}px` }">
    <img
      v-if="src && !failed"
      :src="src"
      :alt="displayName(item)"
      draggable="false"
      @error="failed = true"
    />
    <span v-else class="app-icon__fallback">{{ initial }}</span>
  </div>
</template>

<style scoped>
.app-icon {
  width: var(--s);
  height: var(--s);
  flex: none;
  display: grid;
  place-items: center;
  border-radius: calc(var(--s) * 0.22);
  overflow: hidden;
}

.app-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: -webkit-optimize-contrast;
}

.app-icon__fallback {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--tag-bg);
  color: var(--accent);
  font-size: calc(var(--s) * 0.42);
  font-weight: 500;
}
</style>
