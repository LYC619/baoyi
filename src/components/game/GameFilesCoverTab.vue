<script setup lang="ts">
import { ref } from 'vue'
import { Image, ImageOff, Loader2, X } from 'lucide-vue-next'
import GameCover from '@/components/game/GameCover.vue'
import GameResources from '@/components/game/GameResources.vue'
import { isWindowsGameEntry } from '@/utils/game-entry'
import { formatBytes } from '@/utils'
import type { CoverCandidate, GameCoverDiagnostic, GameItem } from '@/types'

const COVER_SOURCE_LABEL = { local: '本地图片', official: '官方', steam: 'Steam', search: '图片搜索' }
const COVER_STAGE_LABEL = { identity: '名称核对', lookup: '检索', network: '网络', decode: '解析', cache: '缓存', write: '保存' }

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
      <h2 class="sec-title">{{ isWindowsGameEntry(item.path) ? '启动入口' : '安装包与资源' }}</h2>
      <p v-if="!isWindowsGameEntry(item.path)" class="hint">
        打开顶部文件夹可取用安装包；设备安装、导出与恢复范围见精修记录。
      </p>
      <div v-for="entry in entries" :key="entry.path" class="entry-row">
        <div>
          <b>{{ entry.label }}</b>
          <small class="mono" :title="entry.path">{{ entry.path }}</small>
        </div>
        <span v-if="entry.path === item.path" class="default-badge">★ 默认</span>
        <button v-else type="button" class="btn btn--subtle" @click="emit('default-entry', entry.path)">
          设为默认
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          :disabled="launchDisabledFn(entry.path)"
          @click="emit('launch-entry', entry.path)"
        >
          启动
        </button>
      </div>
    </section>

    <section class="panel cover-panel">
      <h2 class="sec-title">封面 <small>点击图片设置裁切焦点</small></h2>
      <div class="cover-pair">
        <div v-for="shape in ['vert', 'wide'] as const" :key="shape">
          <button
            type="button"
            class="cover-preview"
            :class="'cover-preview--' + shape"
            :aria-label="'设置' + (shape === 'vert' ? '竖版' : '横版') + '封面焦点'"
            @click="focusCover"
          >
            <GameCover
              :item="item"
              :shape="shape"
              @loaded="coverInfo[shape] = $event.composed ? '保留全图自动构图' : $event.width + ' × ' + $event.height"
            />
          </button>
          <small>
            {{ shape === 'vert' ? '竖版' : '横版' }} ·
            {{ item.cover_path || item.background_path ? coverInfo[shape] || '加载中' : '文字封面' }}
          </small>
        </div>
      </div>

      <div class="cover-provenance">
        <p>
          竖图来源：{{
            item.cover_source === 'manual'
              ? '手动选择的本地图片'
              : item.cover_source
                ? COVER_SOURCE_LABEL[item.cover_source]
                : '未记录'
          }}
          <span v-if="item.cover_source_url"> · {{ item.cover_source_url }}</span>
        </p>
        <p>
          横图：{{
            item.background_path
              ? '已保存的本地图片 · ' + item.background_path
              : '未单独设置；由竖图自动构图'
          }}
        </p>
        <p v-if="item.cover_detail">{{ item.cover_detail }}</p>
      </div>

      <label class="focus-control">
        横向焦点
        <input
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
      <label class="focus-control">
        纵向焦点
        <input
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
      <label class="cover-field">
        游戏身份
        <input
          :value="item.identity_name"
          placeholder="实际游戏名称"
          @change="emit('save', { identity_name: ($event.target as HTMLInputElement).value.trim() })"
        />
      </label>
      <label class="cover-field">
        封面关键词
        <input
          :value="item.identity_query"
          :placeholder="item.identity_name || title"
          @change="emit('save', { identity_query: ($event.target as HTMLInputElement).value.trim() })"
        />
      </label>
      <div class="cover-buttons">
        <button type="button" class="btn btn--ghost" :disabled="coverSearching" @click="emit('search-covers')">
          {{ coverSearching ? '搜索中…' : '搜封面' }}
        </button>
        <button type="button" class="btn btn--ghost" @click="emit('pick-cover')">选择竖版图</button>
        <button type="button" class="btn btn--ghost" @click="emit('pick-background', false)">横版图片</button>
        <button
          v-if="item.background_path"
          type="button"
          class="btn btn--subtle"
          @click="emit('pick-background', true)"
        >
          清除横图
        </button>
        <button
          v-if="item.cover_focus"
          type="button"
          class="btn btn--subtle"
          @click="emit('save', { cover_focus: '' })"
        >
          恢复自动构图
        </button>
        <button type="button" class="btn btn--subtle" :disabled="!item.cover_path" @click="emit('clear-cover')">
          恢复默认封面
        </button>
        <button
          v-if="item.cover_source_url && (coverBroken || !item.cover_path)"
          type="button"
          class="btn btn--subtle"
          @click="emit('recover-cover')"
        >
          恢复封面缓存
        </button>
      </div>
    </section>

    <section v-if="coverHits.length > 0 || coverMiss || coverDiagnostics.length" class="panel">
      <h2 class="sec-title">
        <Image :size="14" />
        候选封面
        <span v-if="coverQuery" class="sec-title__note">按「{{ coverQuery }}」检索</span>
        <button type="button" class="sec-title__act" title="收起" @click="emit('close-cover-hits')">
          <X :size="13" />
          收起
        </button>
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
          <span v-else class="coverPick__placeholder" role="img" :aria-label="`${c.label}预览不可用`">
            <ImageOff :size="20" />
            <small>预览不可用</small>
          </span>
          <span class="coverPick__label">{{ c.title || c.label }}</span>
          <span class="coverPick__meta">
            {{ COVER_SOURCE_LABEL[c.source] }} ·
            {{ c.status === 'failed' || brokenPreviews.has(c.url) ? '不可用' : '可用' }}
          </span>
          <span v-if="c.width && c.height" class="coverPick__meta">
            {{ c.width }} × {{ c.height }}<template v-if="c.bytes"> · {{ formatBytes(c.bytes) }}</template>
          </span>
          <span v-if="c.message" class="coverPick__meta coverPick__error">
            {{ c.stage ? COVER_STAGE_LABEL[c.stage] + '：' : '' }}{{ c.message }}
          </span>
          <span v-if="coverPicking === c.url" class="coverPick__busy">
            <Loader2 :size="18" class="spin" />
          </span>
        </button>
      </div>

      <details v-if="coverDiagnostics.length" class="coverDiagnostics">
        <summary>查看检索过程</summary>
        <ul>
          <li
            v-for="(entry, index) in coverDiagnostics"
            :key="index"
            :class="{ coverDiagnostics__failed: entry.status === 'failed' }"
          >
            <span>{{ COVER_SOURCE_LABEL[entry.source] }} · {{ COVER_STAGE_LABEL[entry.stage] }}：{{ entry.message }}</span>
            <small v-if="entry.route">{{ entry.route }}</small>
          </li>
        </ul>
      </details>
    </section>

    <section class="panel">
      <GameResources :game="item" kind="other" @updated="emit('resources-updated', $event)" />
    </section>

    <section class="panel">
      <h2 class="sec-title">文件位置</h2>
      <div class="row">
        <button type="button" class="btn btn--ghost" :disabled="relocating" @click="emit('relocate', 'directory')">
          重新定位文件夹
        </button>
        <button type="button" class="btn btn--subtle" :disabled="relocating" @click="emit('relocate', 'file')">
          更换主程序
        </button>
      </div>
      <dl class="facts">
        <dt>主程序</dt>
        <dd>
          <button
            type="button"
            class="mono truncate link"
            :title="`${item.path}（点击复制）`"
            @click="emit('copy-path', item.path)"
          >
            {{ item.file_name }}
          </button>
        </dd>
        <dt>大小</dt>
        <dd>{{ formatBytes(item.file_size) }}</dd>
        <dt>目录</dt>
        <dd>
          <button
            type="button"
            class="mono truncate link"
            :title="`${item.source_dir}（点击复制）`"
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
