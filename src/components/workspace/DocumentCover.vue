<script setup lang="ts">
import { ref, toRef, computed } from 'vue'
import { useDocumentCovers } from '@/composables/useDocumentCovers'
import type { DocumentItem } from '@/types/workspace'
const props = withDefaults(
  defineProps<{ item: DocumentItem; size?: 'list' | 'grid' | 'detail' }>(),
  { size: 'list' },
)
const element = ref<HTMLElement>()
const { cover, retry } = useDocumentCovers(
  toRef(props, 'item'),
  element,
  props.size === 'detail' ? 10 : 0,
)
const media = computed(() =>
  ['pdf', 'png', 'jpg', 'jpeg'].includes(props.item.format),
)
const status = computed(() =>
  !props.item.available
    ? '原文件暂不可用'
    : cover.value.state === 'loading'
      ? '正在生成封面'
      : cover.value.reason || '首页预览待载入',
)
</script>
<template>
  <div
    ref="element"
    class="document-cover"
    :class="'cover-' + size"
    :data-cover-state="cover.state"
    :data-cover-key="cover.key"
  >
    <img v-if="cover.url" :src="cover.url" :alt="item.name + '的首页封面'" />
    <div v-else class="cover-fallback" :title="cover.reason || item.name">
      <span class="cover-type">{{ item.typeName }}</span>
      <strong>{{ item.name }}</strong>
      <span class="cover-line" />
      <small>{{ media ? status : item.author || '文字资料' }}</small>
    </div>
    <span class="cover-format">{{ item.format.toUpperCase() }}</span>
    <button
      v-if="cover.state === 'failed'"
      class="cover-retry"
      :aria-label="'重试封面 ' + item.name"
      @click.stop="retry"
    >
      重试
    </button>
    <span
      v-if="media && ['failed', 'unavailable'].includes(cover.state)"
      class="cover-status"
      :title="status"
      :aria-label="status"
      >!</span
    >
  </div>
</template>
<style scoped>
.document-cover {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--divider);
  border-radius: 3px;
  background: var(--ws-paper);
  box-shadow: 0 2px 5px #0001;
  color: var(--text-main);
}
.document-cover img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #fff;
}
.cover-list {
  width: 50px;
  height: 70px;
}
.cover-grid {
  width: 130px;
  height: 184px;
  margin: 0 auto;
}
.cover-detail {
  width: 158px;
  height: 224px;
  margin: 0 auto;
}
.cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 12px;
  background: linear-gradient(140deg, var(--ws-paper), var(--ws-tint));
  text-align: left;
  overflow: hidden;
}
.cover-fallback strong {
  font-size: 14px;
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}
.cover-type {
  font-size: 9px;
  color: var(--accent);
  margin-bottom: 9px;
}
.cover-line {
  height: 2px;
  width: 28px;
  background: var(--accent);
  margin: 12px 0;
}
.cover-fallback small {
  font-size: 9px;
  color: var(--text-sub);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.cover-format {
  position: absolute;
  right: 2px;
  bottom: 2px;
  font-size: 8px;
  padding: 1px 3px;
  border-radius: 2px;
  background: var(--bg-main);
  color: var(--text-sub);
}
.cover-list .cover-fallback {
  padding: 5px;
}
.cover-list .cover-fallback strong {
  font-size: 9px;
  -webkit-line-clamp: 4;
}
.cover-list .cover-type,
.cover-list .cover-line,
.cover-list .cover-fallback small {
  display: none;
}
.cover-retry {
  position: absolute;
  bottom: 16px;
  background: var(--bg-main);
  border: 1px solid var(--divider);
  padding: 2px 5px;
  font-size: 10px;
  border-radius: 3px;
}
.cover-status {
  position: absolute;
  top: 2px;
  right: 2px;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--bg-main);
  color: var(--text-sub);
  font-size: 10px;
}
</style>
