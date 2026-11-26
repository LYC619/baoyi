<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { computed } from 'vue'
import { FolderOpen, Subtitles } from 'lucide-vue-next'
import { WATCH_STATUS_LABEL } from '@/stores/video'
import {
  formatBytes,
  formatDate,
  formatPosition,
  formatRelative,
  PROTECTED_FIELD_LABEL,
} from '@/utils'
import type { MediaTrack, VideoItem } from '@/types'
import type { VideoWorkLibrary } from '@/types/video-workflow'



const props = defineProps<{
  item: VideoItem
  library: VideoWorkLibrary | null
  collectionGroups: Array<{ name: string; count: number }>
}>()

const emit = defineEmits<{
  (e: 'reveal'): void
  (e: 'open-organize', mode: 'relocate' | 'history'): void
  (e: 'save', patch: Partial<VideoItem>): void
  (e: 'open-source'): void
  (e: 'view-collection', name: string): void
  (e: 'unprotect', fields: string[]): void
  (e: 'copy-path', path: string): void
  (e: 'reveal-sub', path: string): void
}>()

const isSeries = computed(() => props.item.video_type === 'series')
const editedFields = computed(() =>
  (props.item.user_edited ?? []).map((field) => ({
    field,
    label: PROTECTED_FIELD_LABEL[field] ?? field,
  }))
)
const embeddedSubs = computed(() => (props.item.subtitle_tracks ?? []).filter((t) => !t.path))
const externalSubs = computed(() => (props.item.subtitle_tracks ?? []).filter((t) => !!t.path))
const trackText = (t: MediaTrack): string => [t.label || t.language || tr("未知"), t.codec].filter(Boolean).join(' · ')
</script>

<template>
  <section id="video-panel-files" role="tabpanel" aria-labelledby="video-tab-files" tabindex="0">
    <div class="detail-info-grid">
      <section class="panel">
        <h2 class="sec-title">{{ $t("作品目录") }}</h2>
        <p class="read-text mono">{{ library?.directory?.path || item.path }}</p>
        <div class="file-management-actions">
          <button class="btn btn--ghost" type="button" @click="emit('reveal')">
            <FolderOpen :size="13" />{{ $t("打开目录") }}</button>
          <button class="btn btn--ghost" type="button" @click="emit('open-organize', 'relocate')">{{ $t("管理目录") }}</button>
          <button class="btn btn--subtle" type="button" @click="emit('open-organize', 'history')">{{ $t("整理记录") }}</button>
        </div>
      </section>

      <section class="panel">
        <h2 class="sec-title">{{ $t("收藏分组") }}</h2>
        <input
          class="input"
          :value="item.collection_name || ''"
          :aria-label="$t('视频分组')"
          maxlength="80"
          list="video-collection-options"
          :placeholder="$t('未分组')"
          @change="emit('save', { collection_name: ($event.target as HTMLInputElement).value.trim() })"
        />
        <p class="panel__note">{{ $t("收藏分组用于归拢作品，不会改动磁盘文件位置。") }}</p>
        <div class="file-management-actions">
          <button type="button" class="btn btn--subtle" @click="emit('open-source')">{{ $t("搜索 / 绑定来源") }}</button>
          <button
            v-if="item.collection_name"
            type="button"
            class="btn btn--ghost"
            @click="emit('view-collection', item.collection_name)"
          >
            <FolderOpen :size="14" />{{ $t("查看分组") }}</button>
        </div>
        <datalist id="video-collection-options">
          <option v-for="group in collectionGroups" :key="group.name" :value="group.name" />
        </datalist>
      </section>

      <section v-if="editedFields.length > 0" class="panel">
        <h2 class="sec-title">{{ $t("手动保留的字段") }}</h2>
        <p class="panel__note">{{ $t("重新识别时以下字段会保留你的手动修改，不会被自动覆盖。") }}</p>
        <ul class="edited">
          <li v-for="f in editedFields" :key="f.field" class="edited__row">
            <span class="edited__name">{{ f.label }}</span>
            <button
              type="button"
              class="edited__undo"
              :title="$t('下次重新识别时允许更新此栏')"
              @click="emit('unprotect', [f.field])"
            >{{ $t("取消保留") }}</button>
          </li>
        </ul>
        <button v-if="editedFields.length > 1" type="button" class="edited__all" @click="emit('unprotect', [])">{{ $t("全部取消保留") }}</button>
      </section>

      <section class="panel">
        <h2 class="sec-title">{{ $t("观看记录") }}</h2>
        <dl class="facts">
          <dt>{{ $t("状态") }}</dt>
          <dd>{{ WATCH_STATUS_LABEL[item.watch_status] }}</dd>
          <template v-if="isSeries">
            <dt>{{ $t("进度") }}</dt>
            <dd>{{ $t("已看 {p0} 项 · 共 {p1} 项", {p0: (item.episode_watched), p1: (item.episode_total)}) }}</dd>
          </template>
          <template v-else-if="item.position_sec > 0">
            <dt>{{ $t("播放位置") }}</dt>
            <dd>{{ formatPosition(item.position_sec) }}</dd>
          </template>
          <dt>{{ $t("上次观看") }}</dt>
          <dd>{{ item.last_watched_at ? formatRelative(item.last_watched_at) : $t('未观看') }}</dd>
          <dt>{{ $t("收录于") }}</dt>
          <dd>{{ formatDate(item.created_at) }}</dd>
        </dl>
      </section>

      <section class="panel">
        <h2 class="sec-title">{{ $t("规格") }}</h2>
        <dl class="facts">
          <template v-if="item.video_codec">
            <dt>{{ $t("编码") }}</dt>
            <dd>{{ item.video_codec }}</dd>
          </template>
          <template v-if="item.source">
            <dt>{{ $t("片源") }}</dt>
            <dd>{{ item.source }}</dd>
          </template>
          <template v-if="item.release_group">
            <dt>{{ $t("制作组") }}</dt>
            <dd>{{ item.release_group }}</dd>
          </template>
          <template v-if="item.audio_tracks.length > 0">
            <dt>{{ $t("音轨") }}</dt>
            <dd>{{ item.audio_tracks.map(trackText).join('，') }}</dd>
          </template>
          <template v-if="embeddedSubs.length > 0">
            <dt>{{ $t("内嵌字幕") }}</dt>
            <dd>{{ embeddedSubs.map(trackText).join('，') }}</dd>
          </template>
          <dt>{{ isSeries ? $t('目录') : $t('文件') }}</dt>
          <dd>
            <button
              type="button"
              class="mono truncate link"
              :title="$t('{p0}（点击复制）', {p0: item.path})"
              @click="emit('copy-path', item.path)"
            >
              {{ item.file_name }}
            </button>
          </dd>
          <template v-if="item.file_size > 0">
            <dt>{{ $t("大小") }}</dt>
            <dd>{{ formatBytes(item.file_size) }}</dd>
          </template>
        </dl>
      </section>

      <section v-if="externalSubs.length > 0" class="panel">
        <h2 class="sec-title">{{ $t("外挂字幕") }}<span class="sec-title__count">{{ externalSubs.length }}</span>
        </h2>
        <ul class="subs">
          <li v-for="sub in externalSubs" :key="sub.path" class="sub">
            <Subtitles :size="13" class="sub__icon" />
            <span class="sub__label truncate" :title="sub.path">{{ sub.label || sub.language || $t('字幕') }}</span>
            <span v-if="sub.codec" class="sub__codec mono">{{ sub.codec }}</span>
            <button
              type="button"
              class="sub__act"
              :title="$t('在文件夹中定位字幕文件')"
              @click="emit('reveal-sub', sub.path)"
            >
              <FolderOpen :size="12" />
            </button>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.detail-info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  align-items: start;
}
.sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-sub);
}
.sec-title__count {
  margin-left: auto;
  font-size: var(--fs-tag);
  font-weight: 400;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.read-text {
  font-size: var(--fs-body);
  color: var(--text-sub);
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.file-management-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.panel__note {
  margin: 6px 0 10px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  line-height: 1.6;
}
.edited {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.edited__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: var(--fs-tag);
}
.edited__name {
  color: var(--text-sub);
}
.edited__undo,
.edited__all {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  white-space: nowrap;
}
.edited__undo:hover,
.edited__all:hover {
  color: var(--accent);
}
.edited__all {
  margin-top: 8px;
  text-align: left;
}
.facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px 12px;
  font-size: var(--fs-tag);
}
.facts dt {
  color: var(--text-faint);
  white-space: nowrap;
}
.facts dd {
  min-width: 0;
  color: var(--text-sub);
  margin: 0;
}
.link {
  max-width: 100%;
  text-align: left;
  color: var(--text-sub);
}
.link:hover {
  color: var(--accent);
}
.subs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.sub {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 4px;
  border-radius: var(--radius-btn);
  font-size: var(--fs-tag);
}
.sub:hover {
  background: var(--hover-surface);
}
.sub__icon {
  flex: none;
  color: var(--text-faint);
}
.sub__label {
  flex: 1;
  min-width: 0;
  color: var(--text-sub);
}
.sub__codec {
  flex: none;
  color: var(--text-faint);
}
.sub__act {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity var(--t-fast) ease;
}
.sub:hover .sub__act,
.sub:focus-within .sub__act {
  opacity: 1;
}
.sub__act:hover {
  color: var(--accent);
}
</style>
