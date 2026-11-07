<script setup lang="ts">
import { ref, computed } from 'vue'
import type { OutlineNode } from '@/utils/pdf-outline'
const props = defineProps<{
  nodes: OutlineNode[]
  loading: boolean
  error: string
  truncated: boolean
  active: string
}>()
const emit = defineEmits<{ navigate: [node: OutlineNode] }>()
const collapsed = ref(new Set<string>())
const visible = computed(() => {
  const result: Array<{ node: OutlineNode; depth: number }> = []
  function visit(nodes: OutlineNode[], depth: number) {
    for (const node of nodes) {
      result.push({ node, depth })
      if (!collapsed.value.has(node.id)) visit(node.children, depth + 1)
    }
  }
  visit(props.nodes, 0)
  return result
})
function toggle(node: OutlineNode) {
  const next = new Set(collapsed.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  collapsed.value = next
}
</script>
<template>
  <nav class="pdf-outline" aria-label="PDF 章节目录">
    <p v-if="loading" class="ws-muted" role="status">正在读取章节目录…</p>
    <p v-else-if="error" class="ws-error" role="status">{{ error }}</p>
    <p v-else-if="!nodes.length" class="ws-muted">此 PDF 未提供章节目录</p>
    <p v-if="truncated" class="ws-notice">部分目录未展示</p>
    <div
      v-for="{ node, depth } in visible"
      :key="node.id"
      class="outline-row"
      :style="{ paddingLeft: Math.min(depth, 8) * 12 + 'px' }"
    >
      <button
        v-if="node.children.length"
        class="outline-toggle"
        :aria-label="
          (collapsed.has(node.id) ? '展开' : '收起') + '章节 ' + node.title
        "
        :aria-expanded="!collapsed.has(node.id)"
        @click="toggle(node)"
      >
        {{ collapsed.has(node.id) ? '▸' : '▾' }}
      </button>
      <span v-else class="outline-spacer" />
      <button
        class="outline-title"
        :class="{ active: active === node.id }"
        :aria-current="active === node.id ? 'location' : undefined"
        @click="
          node.dest !== null
            ? emit('navigate', node)
            : node.children.length
              ? toggle(node)
              : emit('navigate', node)
        "
      >
        {{ node.title }}
      </button>
    </div>
  </nav>
</template>
<style scoped>
.pdf-outline {
  margin: 12px 0 20px;
  font-size: 12px;
}
.outline-row {
  display: flex;
  align-items: flex-start;
  gap: 3px;
}
.outline-toggle,
.outline-spacer {
  flex: 0 0 18px;
}
.outline-toggle {
  padding: 8px 0;
  color: var(--text-sub);
}
.outline-title {
  flex: 1;
  text-align: left;
  overflow-wrap: anywhere;
  padding: 8px 5px;
  line-height: 1.6;
  color: var(--text-main);
  border-radius: 4px;
}
.outline-title:hover,
.outline-title.active {
  background: var(--ws-tint);
  color: var(--accent);
}
</style>
