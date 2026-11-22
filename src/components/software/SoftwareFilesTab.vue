<script setup lang="ts">
import { FolderInput, FolderOpen, Loader2, Play, Unlink } from 'lucide-vue-next'
import TagBadge from '@/components/ui/TagBadge.vue'
import SoftwareTypeSelect from '@/components/software/SoftwareTypeSelect.vue'
import { isMobilePackage } from '@/utils/software-package'
import { formatBytes } from '@/utils'
import type { SoftwareItem } from '@/types'

defineProps<{
  item: SoftwareItem
  locationDir: string
  categoryBusy: boolean
  linkBusy: boolean
  typeBusy: boolean
}>()

const emit = defineEmits<{
  (e: 'launch-with', path: string): void
  (e: 'set-default', path: string): void
  (e: 'copy-path', path: string): void
  (e: 'update:typeBusy', busy: boolean): void
  (e: 'type-updated', updated: SoftwareItem): void
  (e: 'to-entity'): void
  (e: 'drop-link'): void
}>()
</script>

<template>
  <div
    id="software-panel-files"
    role="tabpanel"
    aria-labelledby="software-tab-files"
    tabindex="0"
    class="detail-panel detail-panel--files"
  >
    <section class="panel">
      <h2 class="sec-title">
        启动端
        <span v-if="item.launchers.length > 1" class="sec-title__count">
          {{ item.launchers.length }}
        </span>
      </h2>
      <p class="sec-note">
        同一个软件的 32/64 位和附属程序都归在这里。点击左侧按钮直接启动，点击「设为默认」可更换主启动目标。
      </p>
      <ul class="launchers">
        <li
          v-for="l in item.launchers"
          :key="l.path"
          :class="{ 'launchers__row--extra': l.kind === 'extra' }"
        >
          <button
            type="button"
            class="launchers__go"
            :title="`${isMobilePackage(l.path) ? '定位安装包' : '启动'} ${l.path}`"
            @click="emit('launch-with', l.path)"
          >
            <FolderOpen v-if="isMobilePackage(l.path)" :size="13" />
            <Play v-else :size="13" />
          </button>
          <div class="launchers__body">
            <div class="launchers__line">
              <span class="launchers__name mono">{{ l.path.split('\\').pop() }}</span>
              <TagBadge v-if="l.label" :label="l.label" tone="muted" />
              <TagBadge v-if="l.is_default" label="默认" tone="success" />
              <TagBadge v-else-if="l.kind === 'extra'" label="附属" tone="muted" />
            </div>
            <button type="button" class="launchers__path mono" :title="l.path" @click="emit('copy-path', l.path)">
              {{ l.path }}
            </button>
          </div>
          <button
            v-if="!l.is_default"
            type="button"
            class="launchers__set"
            @click="emit('set-default', l.path)"
          >
            设为默认
          </button>
        </li>
      </ul>
    </section>

    <section class="panel">
      <h2 class="sec-title">位置信息</h2>
      <dl class="kv">
        <dt>当前位置</dt>
        <dd>
          <button type="button" class="link-btn mono" :title="locationDir" @click="emit('copy-path', locationDir)">
            {{ locationDir }}
          </button>
        </dd>
        <dt>位置类型</dt>
        <dd>
          <TagBadge
            :label="item.link_target ? '目录链接' : '实体目录'"
            :tone="item.link_target ? 'alt' : 'muted'"
          />
        </dd>
        <template v-if="item.link_target">
          <dt>实际指向</dt>
          <dd>
            <button
              type="button"
              class="link-btn mono"
              :title="item.link_target"
              @click="emit('copy-path', item.link_target)"
            >
              {{ item.link_target }}
            </button>
          </dd>
        </template>
        <dt>安装类型</dt>
        <dd>
          <SoftwareTypeSelect
            :id="item.id"
            :model-value="item.is_portable"
            :disabled="categoryBusy || linkBusy || typeBusy"
            @busy="emit('update:typeBusy', $event)"
            @updated="emit('type-updated', $event)"
          />
        </dd>
        <dt>移动风险</dt>
        <dd>
          <TagBadge
            :label="{ safe: '可安全移动', risky: '有风险', unknown: '待确认' }[item.move_risk]"
            :tone="item.move_risk === 'safe' ? 'success' : item.move_risk === 'risky' ? 'warning' : 'muted'"
          />
        </dd>
      </dl>

      <p v-if="item.link_target" class="sec-note sec-note--foot">
        整理目录里存放的是目录链接，软件本体仍留在原安装位置。「转为实体」会把真实文件搬到此处；「移除链接」只删链接并将路径退回原位置，两者都不会删除你的软件。
      </p>

      <div v-if="item.link_target" class="row row--foot">
        <button type="button" class="btn btn--ghost" :disabled="linkBusy" @click="emit('to-entity')">
          <Loader2 v-if="linkBusy" :size="14" class="spin" />
          <FolderInput v-else :size="14" />
          转为实体
        </button>
        <button type="button" class="btn btn--subtle" :disabled="linkBusy" @click="emit('drop-link')">
          <Unlink :size="14" />
          移除链接
        </button>
      </div>
    </section>

    <section class="panel">
      <h2 class="sec-title">文件信息</h2>
      <dl class="kv">
        <dt>文件名</dt>
        <dd class="mono">{{ item.file_name }}</dd>
        <dt>开发商</dt>
        <dd>{{ item.company || '—' }}</dd>
        <dt>版本</dt>
        <dd class="mono">{{ item.version || '—' }}</dd>
        <dt>大小</dt>
        <dd>{{ formatBytes(item.file_size) }}</dd>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.sec-title {
  font-size: var(--fs-tag);
  font-weight: 500;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  margin-bottom: 10px;
}
.sec-title__count {
  margin-left: 6px;
  font-family: var(--font-mono);
  letter-spacing: 0;
}
.sec-note {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-faint);
  margin: -4px 0 10px;
}
.sec-note--foot {
  margin: 10px 0 0;
}
.kv {
  display: grid;
  grid-template-columns: 68px 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: var(--fs-body);
}
.kv dt {
  color: var(--text-faint);
  font-size: var(--fs-tag);
}
.kv dd {
  margin: 0;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
}
.launchers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.launchers li {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-main);
  border: 1px solid var(--divider);
}
.launchers__row--extra {
  opacity: 0.72;
}
.launchers__go {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-sub);
  background: var(--hover-surface);
  transition: background var(--t-fast) ease, color var(--t-fast) ease;
}
.launchers__go:hover {
  background: var(--active-surface);
  color: var(--accent);
}
.launchers__body {
  flex: 1;
  min-width: 0;
}
.launchers__line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.launchers__name {
  font-size: var(--fs-tag);
  color: var(--text-main);
}
.launchers__path {
  display: block;
  width: 100%;
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-faint);
  text-align: left;
  word-break: break-all;
  transition: color var(--t-fast) ease;
}
.launchers__path:hover {
  color: var(--text-sub);
}
.launchers__set {
  flex-shrink: 0;
  align-self: center;
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  transition: color var(--t-fast) ease;
}
.launchers__set:hover {
  color: var(--accent);
}
.link-btn {
  display: block;
  width: 100%;
  text-align: left;
  color: var(--text-sub);
  word-break: break-all;
  line-height: 1.6;
  transition: color var(--t-fast) ease;
}
.link-btn:hover {
  color: var(--accent);
}
.row--foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.spin {
  animation: spin 900ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
