<script setup lang="ts">
import { ref } from 'vue'
import { ExternalLink, Play } from 'lucide-vue-next'
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import VideoArtwork from '@/components/video/VideoArtwork.vue'
import VideoScopeSwitch from '@/components/video/VideoScopeSwitch.vue'
import { formatDuration } from '@/utils'
import { videoDateLabel, videoEpisodeLabel } from '@/utils/video-content'
import type { Episode, VideoItem } from '@/types'
import type { VideoWorkContent, VideoWorkLibrary } from '@/types/video-workflow'

defineProps<{
  mode: 'description' | 'notes'
  item: VideoItem
  title: string
  library: VideoWorkLibrary | null
  selectedEpisode: VideoWorkContent | null
  selectedEpisodeId: string
  editing: boolean
  playing: boolean
  playHint: string
  busyEpisode: string
}>()

const emit = defineEmits<{
  (e: 'update:selectedEpisodeId', id: string): void
  (e: 'play'): void
  (e: 'scrape-selected'): void
  (e: 'open-source'): void
  (e: 'pick-episode-image', role: 'poster' | 'thumbnail'): void
  (e: 'remove-episode', id: string): void
  (e: 'save-episode', patch: Partial<Episode>): void
  (e: 'save-work', patch: Partial<VideoItem>): void
  (e: 'filter-tag', tag: string): void
  (e: 'open-url', url: string): void
}>()

const episodeEditing = ref(false)
const hasVideo = (content: VideoWorkContent) =>
  content.assets.some((asset) => asset.role === 'video' && asset.state === 'present')
</script>

<template>
  <section
    v-if="mode === 'description'"
    id="video-panel-description"
    class="panel episode-reading"
    role="tabpanel"
    aria-labelledby="video-tab-description"
    tabindex="0"
  >
    <header class="episode-reading__head">
      <div>
        <h2>{{ selectedEpisode ? videoEpisodeLabel(selectedEpisode, item.category === '里番') : '作品简介' }}</h2>
        <p>{{ selectedEpisode ? '单集故事与资料' : '整部作品的介绍' }}</p>
      </div>
      <VideoScopeSwitch
        v-if="library?.contents.length"
        :model-value="selectedEpisodeId"
        :episodes="library.contents"
        :without-season="item.category === '里番'"
        @update:model-value="emit('update:selectedEpisodeId', $event)"
      />
    </header>

    <template v-if="selectedEpisode">
      <div class="episode-actions">
        <button
          type="button"
          class="btn btn--primary"
          :disabled="playing || !hasVideo(selectedEpisode)"
          :title="playHint"
          @click="emit('play')"
        >
          <Play :size="13" />{{ playing ? '正在打开…' : '播放这一集' }}
        </button>
        <button type="button" class="btn btn--subtle" @click="episodeEditing = !episodeEditing">
          {{ episodeEditing ? '完成单集编辑' : '编辑这一集' }}
        </button>
        <button type="button" class="btn btn--subtle" :disabled="!!busyEpisode" @click="emit('scrape-selected')">
          {{ busyEpisode ? '正在获取资料…' : '获取单集资料' }}
        </button>
        <button type="button" class="btn btn--ghost" @click="emit('open-source')">更改来源</button>
        <button type="button" class="btn btn--ghost" @click="emit('pick-episode-image', 'poster')">选择封面</button>
        <button type="button" class="btn btn--ghost" @click="emit('pick-episode-image', 'thumbnail')">选择预览图</button>
        <button type="button" class="btn btn--ghost" @click="emit('remove-episode', selectedEpisode.id)">
          移除 / 移出合集…
        </button>
      </div>

      <div
        class="episode-summary"
        :class="{ 'episode-summary--text-only': !selectedEpisode.poster_path && !selectedEpisode.thumbnail_path }"
      >
        <VideoArtwork :poster="selectedEpisode.poster_path" :thumbnail="selectedEpisode.thumbnail_path" />
        <div class="episode-copy">
          <label v-if="episodeEditing">
            单集标题
            <input
              class="input"
              :value="selectedEpisode.title"
              @change="emit('save-episode', { title: ($event.target as HTMLInputElement).value.trim() })"
            />
          </label>
          <div class="episode-reading__title">
            <h3>{{ selectedEpisode.original_title || selectedEpisode.title }}</h3>
            <p v-if="selectedEpisode.original_title && selectedEpisode.original_title !== selectedEpisode.title">
              {{ selectedEpisode.title }}
            </p>
          </div>
          <dl
            v-if="
              selectedEpisode.air_date ||
              selectedEpisode.published_at ||
              selectedEpisode.studio ||
              selectedEpisode.duration_sec
            "
            class="episode-facts"
            aria-label="单集基本资料"
          >
            <div v-if="selectedEpisode.air_date">
              <dt>发行日期</dt>
              <dd>{{ videoDateLabel(selectedEpisode.air_date) }}</dd>
            </div>
            <div v-if="selectedEpisode.published_at">
              <dt>发布日期</dt>
              <dd>{{ videoDateLabel(selectedEpisode.published_at) }}</dd>
            </div>
            <div v-if="selectedEpisode.studio">
              <dt>厂牌 / 作者</dt>
              <dd>{{ selectedEpisode.studio }}</dd>
            </div>
            <div v-if="selectedEpisode.duration_sec">
              <dt>片长</dt>
              <dd>{{ formatDuration(selectedEpisode.duration_sec) }}</dd>
            </div>
          </dl>
          <label v-if="editing || episodeEditing" class="episode-reading__original">
            原名
            <input
              class="input"
              :value="selectedEpisode.original_title || ''"
              aria-label="单集原名"
              @change="emit('save-episode', { original_title: ($event.target as HTMLInputElement).value.trim() })"
            />
          </label>
          <EditableField
            v-if="editing || episodeEditing"
            :key="'description-' + selectedEpisode.id"
            :model-value="selectedEpisode.description || ''"
            multiline
            placeholder="补充单集剧情简介"
            @commit="emit('save-episode', { description: $event })"
          />
          <p v-else class="read-text">{{ selectedEpisode.description || '本集暂无简介，可在编辑资料中补充。' }}</p>
          <details
            v-if="selectedEpisode.original_description && selectedEpisode.original_description !== selectedEpisode.description"
            class="original-description"
          >
            <summary>查看原文介绍</summary>
            <p>{{ selectedEpisode.original_description }}</p>
          </details>
          <button
            v-if="selectedEpisode.source_url"
            class="btn btn--subtle episode-reading__source"
            type="button"
            @click="emit('open-url', selectedEpisode.source_url)"
          >
            <ExternalLink :size="13" />查看单集来源
          </button>
        </div>
      </div>

      <div class="tags episode-tags">
        <TagBadge
          v-for="tag in selectedEpisode.tags || []"
          :key="tag"
          :label="tag"
          clickable
          @click="emit('filter-tag', tag)"
        />
      </div>
      <EditableField
        v-if="episodeEditing"
        :key="'tags-' + selectedEpisode.id"
        :model-value="(selectedEpisode.tags || []).join('、')"
        placeholder="单集标签，用顿号分隔"
        @commit="
          emit('save-episode', {
            tags: $event
              .split(/[、,，]/)
              .map((t) => t.trim())
              .filter(Boolean),
          })
        "
      />
    </template>

    <template v-else>
      <div
        class="episode-summary"
        :class="{ 'episode-summary--text-only': !item.poster_path && !item.thumbnail_path }"
      >
        <VideoArtwork :poster="item.poster_path" :thumbnail="item.thumbnail_path" />
        <div class="episode-copy">
          <div class="episode-reading__title">
            <h3>{{ title }}</h3>
            <p v-if="item.name_en && item.name_en !== title">{{ item.name_en }}</p>
          </div>
          <EditableField
            v-if="editing"
            :model-value="item.description"
            multiline
            placeholder="整部作品讲的是什么"
            @commit="emit('save-work', { description: $event })"
          />
          <p v-else class="read-text">
            {{
              item.description ||
              (library?.contents.length
                ? '暂无整部作品简介。可切换上方集数查看各集独立介绍。'
                : '尚无简介，可在编辑资料中补充。')
            }}
          </p>
          <details v-if="item.original_description" class="original-description">
            <summary>查看原文介绍</summary>
            <p>{{ item.original_description }}</p>
          </details>
        </div>
      </div>
    </template>
  </section>

  <section
    v-else
    id="video-panel-notes"
    class="panel episode-reading"
    role="tabpanel"
    aria-labelledby="video-tab-notes"
    tabindex="0"
  >
    <header class="episode-reading__head">
      <div>
        <h2>{{ selectedEpisode ? videoEpisodeLabel(selectedEpisode, item.category === '里番') + ' · 笔记' : '作品笔记' }}</h2>
        <p>{{ selectedEpisode ? selectedEpisode.original_title || selectedEpisode.title : '记录观影感受、版本偏好或随手备忘' }}</p>
      </div>
      <VideoScopeSwitch
        v-if="library?.contents.length"
        :model-value="selectedEpisodeId"
        :episodes="library.contents"
        :without-season="item.category === '里番'"
        notes
        @update:model-value="emit('update:selectedEpisodeId', $event)"
      />
    </header>
    <EditableField
      v-if="editing"
      :key="'notes-' + selectedEpisodeId"
      :model-value="selectedEpisode ? selectedEpisode.notes || '' : item.notes"
      multiline
      placeholder="看到哪里、哪个版本、想记下的话…"
      @commit="selectedEpisode ? emit('save-episode', { notes: $event }) : emit('save-work', { notes: $event })"
    />
    <p v-else class="read-text">{{ (selectedEpisode ? selectedEpisode.notes : item.notes) || '暂无笔记' }}</p>
  </section>
</template>

<style scoped>
.episode-reading {
  min-height: 220px;
  padding: 20px 24px;
}
.episode-reading__head {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 16px;
  margin-bottom: 22px;
  padding-bottom: 15px;
  border-bottom: 1px solid var(--divider);
}
.episode-reading__head > div {
  min-width: 0;
}
.episode-reading__head h2 {
  font-size: 15px;
  font-weight: 600;
}
.episode-reading__head p {
  color: var(--text-sub);
  font-size: 12px;
  line-height: 1.6;
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.episode-reading__title {
  margin-bottom: 16px;
}
.episode-reading__title h3 {
  font-size: 17px;
  font-weight: 500;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.episode-reading__title p {
  color: var(--text-sub);
  font-size: 12px;
  margin-top: 4px;
}
.read-text {
  font-size: var(--fs-body);
  color: var(--text-sub);
  max-width: 76ch;
  line-height: 1.9;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.episode-reading__source {
  margin-top: 20px;
}
.episode-reading__original {
  display: grid;
  gap: 6px;
  margin-bottom: 14px;
  color: var(--text-sub);
  font-size: 12px;
}
.episode-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 28px;
  margin-block: 16px;
  font-size: var(--fs-body);
}
.episode-facts > div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.episode-facts dt {
  color: var(--text-sub);
}
.episode-facts dd {
  margin: 0;
  color: var(--text-main);
  overflow-wrap: anywhere;
}
.episode-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.episode-summary {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: start;
  gap: 22px;
}
.episode-summary--text-only {
  grid-template-columns: minmax(0, 1fr);
}
.episode-copy {
  min-width: 0;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.episode-tags {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--divider);
}
.original-description {
  margin-top: 12px;
  color: var(--text-sub);
  font-size: var(--fs-tag);
  line-height: 1.7;
}
.original-description summary {
  cursor: pointer;
  color: var(--text-faint);
}
.original-description summary:hover {
  color: var(--accent);
}
.original-description p {
  margin: 8px 0 0;
  white-space: pre-wrap;
}
@media (max-width: 720px) {
  .episode-reading {
    padding: 16px;
  }
  .episode-reading__head {
    flex-wrap: wrap;
  }
  .episode-summary {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
