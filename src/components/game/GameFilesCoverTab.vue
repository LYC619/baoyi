<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { ref } from 'vue'
import { Image, ImageOff, Loader2, X } from 'lucide-vue-next'
import GameCover from '@/components/game/GameCover.vue'
import GameResources from '@/components/game/GameResources.vue'
import { isWindowsGameEntry } from '@/utils/game-entry'
import { formatBytes } from '@/utils'
import type { CoverCandidate, GameCoverDiagnostic, GameItem } from '@/types'

const COVER_SOURCE_LABEL = { get local() { return tr('本地图片') }, get official() { return tr('官方') }, steam: 'Steam', get search() { return tr('图片搜索') } }
const COVER_STAGE_LABEL = { get identity() { return tr('名称核对') }, get lookup() { return tr('检索') }, get network() { return tr('网络') }, get decode() { return tr('解析') }, get cache() { return tr('缓存') }, get write() { return tr('保存') } }

defineProps<{
  item: GameItem
  title: string
  entries: Array<{ path: string; label: string }>
  launchDisabledFn: (entry?: string) => boolean
  coverBroken: boolean
  coverSearching: boolean
  coverPicking: string
  coverHits: CoverCandidate[]
  coverQuery: string
  coverMiss: string
  coverDiagnostics: GameCoverDiagnostic[]
  brokenPreviews: Set<string>
  relocating: boolean
}>()

const emit = defineEmits<{
  (e: 'default-entry', path: string): void
  (e: 'launch-entry', path: string): void
  (e: 'save', patch: Partial<GameItem>): void
  (e: 'search-covers'): void
  (e: 'pick-cover'): void
  (e: 'pick-background', clear?: boolean): void
  (e: 'clear-cover'): void
  (e: 'recover-cover'): void
  (e: 'close-cover-hits'): void
  (e: 'use-cover', url: string): void
  (e: 'preview-failed', candidate: CoverCandidate): void
  (e: 'resources-updated', updated: GameItem): void
  (e: 'relocate', mode: 'directory' | 'file'): void
  (e: 'copy-path', path: string): void
}>()

const coverInfo = ref<Record<string, string>>({})

function focusCover(event: MouseEvent) {
  const r = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = Math.round((100 * (event.clientX - r.left)) / r.width)
  const y = Math.round((100 * (event.clientY - r.top)) / r.height)
  emit('save', { cover_focus: `${x},${y}` })
}
</script>

<template>
  <div
    id="game-panel-files"
    role="tabpanel"
    aria-labelledby="game-tab-files"
    tabindex="0"
    class="detail-panel detail-panel--files"
  >
    <section class="panel entry-panel">
      <h2 class="sec-title">{{ isWindowsGameEntry(item.path) ? $t('启动入口') : $t('安装包与资源') }}</h2>
      <p v-if="!isWindowsGameEntry(item.path)" class="hint">{{ $t("打开顶部文件夹可取用安装包；设备安装、导出与恢复范围见精修记录。") }}</p>
      <div v-for="entry in entries" :key="entry.path" class="entry-row">
        <div>
          <b>{{ entry.label }}</b>
          <small class="mono" :title="entry.path">{{ entry.path }}</small>
        </div>
        <span v-if="entry.path === item.path" class="default-badge">{{ $t("★ 默认") }}</span>
        <button v-else type="button" class="btn btn--subtle" @click="emit('default-entry', entry.path)">{{ $t("设为默认") }}</button>
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          :disabled="launchDisabledFn(entry.path)"
          @click="emit('launch-entry', entry.path)"
        >{{ $t("启动") }}</button>
      </div>
    </section>

    <section class="panel cover-panel">
      <h2 class="sec-title">{{ $t("封面") }}<small>{{ $t("点击图片设置裁切焦点") }}</small></h2>
      <div class="cover-pair">
        <div v-for="shape in ['vert', 'wide'] as const" :key="shape">
          <button
            type="button"
            class="cover-preview"
            :class="'cover-preview--' + shape"
            :aria-label="$t('设置') + (shape === 'vert' ? $t('竖版') : $t('横版')) + $t('封面焦点')"
            @click="focusCover"
          >
            <GameCover
              :item="item"
              :shape="shape"
              @loaded="coverInfo[shape] = $event.composed ? $t('保留全图自动构图') : $event.width + ' × ' + $event.height"
            />
          </button>
          <small>
            {{ shape === 'vert' ? $t('竖版') : $t('横版') }} ·
            {{ item.cover_path || item.background_path ? coverInfo[shape] || $t('加载中') : $t('文字封面') }}
          </small>
        </div>
      </div>

      <div class="cover-provenance">
        <p>{{ $t("竖图来源：{p0}", {p0: (item.cover_source === 'manual'
              ? $t('手动选择的本地图片')
              : item.cover_source
                ? COVER_SOURCE_LABEL[item.cover_source]
                : $t('未记录'))}) }}<span v-if="item.cover_source_url"> · {{ item.cover_source_url }}</span>
        </p>
        <p>{{ $t("横图：{p0}", {p0: (item.background_path
              ? $t('已保存的本地图片 · ') + item.background_path
              : $t('未单独设置；由竖图自动构图'))}) }}
        </p>
        <p v-if="item.cover_detail">{{ item.cover_detail }}</p>
      </div>

      <label class="focus-control">{{ $t("横向焦点") }}<input
          type="range"
          min="0"
          max="100"
          :value="(item.cover_focus || '50,35').split(',')[0]"
          @change="
            emit('save', {
              cover_focus: ($event.target as HTMLInputElement).value + ',' + (item.cover_focus || '50,35').split(',')[1],
            })
          "
        />
      </label>
      <label class="focus-control">{{ $t("纵向焦点") }}<input
          type="range"
          min="0"
          max="100"
          :value="(item.cover_focus || '50,35').split(',')[1]"
          @change="
            emit('save', {
              cover_focus: (item.cover_focus || '50,35').split(',')[0] + ',' + ($event.target as HTMLInputElement).value,
            })
          "
        />
      </label>
      <label class="cover-field">{{ $t("游戏身份") }}<input
          :value="item.identity_name"
          :placeholder="$t('实际游戏名称')"
          @change="emit('save', { identity_name: ($event.target as HTMLInputElement).value.trim() })"
        />
      </label>
      <label class="cover-field">{{ $t("封面关键词") }}<input
          :value="item.identity_query"
          :placeholder="item.identity_name || title"
          @change="emit('save', { identity_query: ($event.target as HTMLInputElement).value.trim() })"
        />
      </label>
      <div class="cover-buttons">
        <button type="button" class="btn btn--ghost" :disabled="coverSearching" @click="emit('search-covers')">
          {{ coverSearching ? $t('搜索中…') : $t('搜封面') }}
        </button>
        <button type="button" class="btn btn--ghost" @click="emit('pick-cover')">{{ $t("选择竖版图") }}</button>
        <button type="button" class="btn btn--ghost" @click="emit('pick-background', false)">{{ $t("横版图片") }}</button>
        <button
          v-if="item.background_path"
          type="button"
          class="btn btn--subtle"
          @click="emit('pick-background', true)"
        >{{ $t("清除横图") }}</button>
        <button
          v-if="item.cover_focus"
          type="button"
          class="btn btn--subtle"
          @click="emit('save', { cover_focus: '' })"
        >{{ $t("恢复自动构图") }}</button>
        <button type="button" class="btn btn--subtle" :disabled="!item.cover_path" @click="emit('clear-cover')">{{ $t("恢复默认封面") }}</button>
        <button
          v-if="item.cover_source_url && (coverBroken || !item.cover_path)"
          type="button"
          class="btn btn--subtle"
          @click="emit('recover-cover')"
        >{{ $t("恢复封面缓存") }}</button>
      </div>
    </section>

    <section v-if="coverHits.length > 0 || coverMiss || coverDiagnostics.length" class="panel">
      <h2 class="sec-title">
        <Image :size="14" />{{ $t("候选封面") }}<span v-if="coverQuery" class="sec-title__note">{{ $t("按「{p0}」检索", {p0: (coverQuery)}) }}</span>
        <button type="button" class="sec-title__act" :title="$t('收起')" @click="emit('close-cover-hits')">
          <X :size="13" />{{ $t("收起") }}</button>
      </h2>

      <p v-if="coverMiss" class="hint">{{ coverMiss }}</p>

      <div v-if="coverHits.length > 0" class="covers">
        <button
          v-for="c in coverHits"
          :key="c.url"
          type="button"
          class="coverPick"
          :class="{
            'coverPick--busy': coverPicking === c.url,
            'coverPick--failed': c.status === 'failed' || brokenPreviews.has(c.url),
          }"
          :style="{ '--candidate-ratio': c.width && c.height ? `${c.width} / ${c.height}` : '2 / 3' }"
          :disabled="!!coverPicking || c.status === 'failed' || brokenPreviews.has(c.url)"
          :title="`${c.title || c.label}\n${c.message || c.label}\n${c.route || ''}\n${c.url}`"
          @click="emit('use-cover', c.url)"
        >
          <img
            v-if="c.preview_url && !brokenPreviews.has(c.url)"
            :src="c.preview_url"
            :alt="c.label"
            class="coverPick__img"
            @error="emit('preview-failed', c)"
          />
          <span v-else class="coverPick__placeholder" role="img" :aria-label="$t('{p0}预览不可用', {p0: c.label})">
            <ImageOff :size="20" />
            <small>{{ $t("预览不可用") }}</small>
          </span>
          <span class="coverPick__label">{{ c.title || c.label }}</span>
          <span class="coverPick__meta">
            {{ COVER_SOURCE_LABEL[c.source] }} ·
            {{ c.status === 'failed' || brokenPreviews.has(c.url) ? $t('不可用') : $t('可用') }}
          </span>
          <span v-if="c.width && c.height" class="coverPick__meta">
            {{ c.width }} × {{ c.height }}<template v-if="c.bytes"> · {{ formatBytes(c.bytes) }}</template>
          </span>
          <span v-if="c.message" class="coverPick__meta coverPick__error">
            {{ c.stage ? COVER_STAGE_LABEL[c.stage] + '：' : '' }}{{ $systemMessage(c.message) }}
          </span>
          <span v-if="coverPicking === c.url" class="coverPick__busy">
            <Loader2 :size="18" class="spin" />
          </span>
        </button>
      </div>

      <details v-if="coverDiagnostics.length" class="coverDiagnostics">
        <summary>{{ $t("查看检索过程") }}</summary>
        <ul>
          <li
            v-for="(entry, index) in coverDiagnostics"
            :key="index"
            :class="{ coverDiagnostics__failed: entry.status === 'failed' }"
          >
            <span>{{ COVER_SOURCE_LABEL[entry.source] }} · {{ COVER_STAGE_LABEL[entry.stage] }}：{{ $systemMessage(entry.message) }}</span>
            <small v-if="entry.route">{{ entry.route }}</small>
          </li>
        </ul>
      </details>
    </section>

    <section class="panel">
      <GameResources :game="item" kind="other" @updated="emit('resources-updated', $event)" />
    </section>

    <section class="panel">
      <h2 class="sec-title">{{ $t("文件位置") }}</h2>
      <div class="row">
        <button type="button" class="btn btn--ghost" :disabled="relocating" @click="emit('relocate', 'directory')">{{ $t("重新定位文件夹") }}</button>
        <button type="button" class="btn btn--subtle" :disabled="relocating" @click="emit('relocate', 'file')">{{ $t("更换主程序") }}</button>
      </div>
      <dl class="facts">
        <dt>{{ $t("主程序") }}</dt>
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
        <dt>{{ $t("大小") }}</dt>
        <dd>{{ formatBytes(item.file_size) }}</dd>
        <dt>{{ $t("目录") }}</dt>
        <dd>
          <button
            type="button"
            class="mono truncate link"
            :title="$t('{p0}（点击复制）', {p0: item.source_dir})"
            @click="emit('copy-path', item.source_dir)"
          >
            {{ item.source_dir }}
          </button>
        </dd>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-sub);
}
.sec-title__act {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: var(--fs-tag);
  font-weight: 400;
  color: var(--text-faint);
}
.sec-title__act:hover {
  color: var(--accent);
}
.sec-title__note {
  font-size: var(--fs-tag);
  font-weight: 400;
  color: var(--text-faint);
}
.cover-provenance {
  font-size: 11px;
  line-height: 1.8;
  color: var(--text-faint);
  overflow-wrap: anywhere;
}
.covers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 10px;
  align-items: start;
}
.coverPick {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: 1px solid var(--divider);
  border-radius: var(--radius-card);
  overflow: hidden;
  background: var(--bg-main);
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
}
.coverPick:hover:not(:disabled) {
  border-color: var(--accent);
  transform: translateY(-2px);
}
.coverPick:disabled {
  cursor: default;
}
.coverPick__img {
  width: 100%;
  aspect-ratio: var(--candidate-ratio, 2 / 3);
  object-fit: contain;
  display: block;
  background: var(--bg-card);
}
.coverPick__placeholder {
  width: 100%;
  aspect-ratio: 2 / 3;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 6px;
  color: var(--text-faint);
  background: var(--bg-card);
  font-size: var(--fs-tag);
}
.coverPick__label {
  padding: 0 7px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  text-align: left;
  overflow-wrap: anywhere;
}
.coverPick__meta {
  padding: 0 7px 5px;
  text-align: left;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  overflow-wrap: anywhere;
}
.coverPick__error,
.coverDiagnostics__failed {
  color: var(--danger);
}
.coverPick--failed {
  opacity: 0.75;
}
.coverDiagnostics {
  margin-top: 14px;
  color: var(--text-sub);
  font-size: var(--fs-tag);
}
.coverDiagnostics summary {
  cursor: pointer;
}
.coverDiagnostics ul {
  display: grid;
  gap: 7px;
  padding-left: 18px;
  margin-top: 10px;
}
.coverDiagnostics li small {
  display: block;
  color: var(--text-faint);
  overflow-wrap: anywhere;
}
.coverPick__busy {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 0.45);
  color: #fff;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
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
.hint {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  line-height: 1.7;
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

<style scoped src="../../pages/game/detail-v21.css" />
