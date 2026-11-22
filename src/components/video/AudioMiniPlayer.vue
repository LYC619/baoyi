<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDockBoundary } from '@/composables/useFloatingDock'
import { useRoute, useRouter } from 'vue-router'
import {
  ListMusic,
  ListOrdered,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX,
  X
} from 'lucide-vue-next'
import { AUDIO_MODE_LABEL, useAudioStore } from '@/stores/audio'
import { formatPosition } from '@/utils'

const audio = useAudioStore()
const route = useRoute()
const router = useRouter()
const player = ref<HTMLAudioElement>()
const bar = ref<HTMLElement>()
const queuePanel = ref<HTMLElement>()
const queueBtn = ref<HTMLButtonElement>()
const queueOpen = ref(false)

useDockBoundary(bar, 'footer', () => !!audio.current || !!audio.online)
watch(player, value => audio.attach(value || null))
watch(() => !audio.current && !audio.online, empty => {
  if (empty) queueOpen.value = false
})

function onDocPointerDown(e: MouseEvent) {
  if (!queueOpen.value) return
  const target = e.target as Node | null
  if (!target) return
  if (queuePanel.value?.contains(target) || queueBtn.value?.contains(target)) return
  queueOpen.value = false
}

function onDocKeyDown(e: KeyboardEvent) {
  if (queueOpen.value && e.key === 'Escape' && !e.isComposing) {
    e.stopPropagation()
    queueOpen.value = false
    queueBtn.value?.focus()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocPointerDown)
  document.addEventListener('keydown', onDocKeyDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointerDown)
  document.removeEventListener('keydown', onDocKeyDown, true)
  audio.close()
  audio.attach(null)
})
</script>

<template>
  <section ref="bar" v-if="audio.current || audio.online" class="audio-mini" aria-label="全局音频播放器">
    <Music2 :size="22" class="audio-mini-icon" />
    <button
      class="audio-mini-title"
      :title="audio.current ? '查看歌词与音频详情' : audio.online?.title"
      :disabled="!audio.current"
      @click="
        audio.current &&
          router.push({
            name: 'video-detail',
            params: { id: audio.current.resource.id },
            query: { track: audio.current.id, ...(!route.path.startsWith('/video') ? { from: route.fullPath } : {}) }
          })
      "
    >
      <strong>{{ audio.current?.title || audio.online?.title }}</strong>
      <small>{{
        [audio.music?.artist, audio.music?.album].filter(Boolean).join(' · ') ||
        audio.current?.resource.name_zh ||
        audio.current?.resource.file_name
      }}</small>
    </button>

    <button aria-label="上一曲" :disabled="!audio.hasPrevious" @click="audio.next(-1)">
      <SkipBack :size="17" />
    </button>
    <button :aria-label="audio.playing ? '暂停音频' : '播放音频'" @click="audio.toggle">
      <Pause v-if="audio.playing" :size="20" />
      <Play v-else :size="20" />
    </button>
    <button aria-label="下一曲" :disabled="!audio.hasNext" @click="audio.next()">
      <SkipForward :size="17" />
    </button>

    <input
      class="audio-mini-seek"
      type="range"
      aria-label="音频播放进度"
      min="0"
      :max="audio.duration || 0"
      step="0.1"
      :value="audio.position"
      @input="audio.seek(Number(($event.target as HTMLInputElement).value))"
    />
    <span class="audio-mini-time">
      {{ formatPosition(audio.position) || '0:00' }} / {{ formatPosition(audio.duration) || '0:00' }}
    </span>

    <button
      v-if="!audio.online"
      type="button"
      class="audio-mini-mode"
      :title="'播放顺序：' + AUDIO_MODE_LABEL[audio.mode] + '（点击切换）'"
      :aria-label="'播放模式：' + AUDIO_MODE_LABEL[audio.mode]"
      @click="audio.cycleMode"
    >
      <Repeat1 v-if="audio.mode === 'one'" :size="16" />
      <Repeat v-else-if="audio.mode === 'loop'" :size="16" />
      <Shuffle v-else-if="audio.mode === 'shuffle'" :size="16" />
      <ListOrdered v-else :size="16" />
    </button>

    <div class="audio-mini-vol">
      <button
        type="button"
        :title="audio.muted || audio.volume === 0 ? '取消静音' : '静音'"
        :aria-label="audio.muted || audio.volume === 0 ? '取消静音' : '静音'"
        @click="audio.toggleMute"
      >
        <VolumeX v-if="audio.muted || audio.volume === 0" :size="16" />
        <Volume2 v-else :size="16" />
      </button>
      <input
        class="audio-mini-vol-slider"
        type="range"
        aria-label="音量"
        min="0"
        max="1"
        step="0.02"
        :value="audio.muted ? 0 : audio.volume"
        @input="audio.setVolume(Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <button
      v-if="audio.queue.length > 0"
      ref="queueBtn"
      type="button"
      class="audio-mini-queue-btn"
      :class="{ active: queueOpen }"
      :aria-expanded="queueOpen"
      aria-label="播放清单"
      title="查看当前播放清单"
      @click="queueOpen = !queueOpen"
    >
      <ListMusic :size="17" />
      <span>{{ audio.queue.length }}</span>
    </button>

    <button aria-label="关闭音频播放器" title="关闭播放器" @click="audio.close">
      <X :size="18" />
    </button>

    <div v-if="queueOpen && audio.queue.length > 0" ref="queuePanel" class="audio-queue-panel" role="region" aria-label="当前播放清单">
      <header class="audio-queue-head">
        <div>
          <strong>播放清单</strong>
          <span>共 {{ audio.queue.length }} 首</span>
        </div>
        <div class="audio-queue-actions">
          <button type="button" class="btn btn--ghost" @click="audio.cycleMode">
            {{ AUDIO_MODE_LABEL[audio.mode] }}
          </button>
          <button type="button" class="btn btn--ghost" title="清空清单并停止播放" @click="audio.close">
            <Trash2 :size="13" />清空
          </button>
        </div>
      </header>
      <ul class="audio-queue-list">
        <li
          v-for="(item, idx) in audio.queue"
          :key="item.id"
          class="audio-queue-item"
          :class="{ current: audio.current?.id === item.id }"
        >
          <button type="button" class="audio-queue-play" @click="audio.play(item)">
            <span class="audio-queue-idx">{{ String(idx + 1).padStart(2, '0') }}</span>
            <span class="audio-queue-meta">
              <strong>{{ item.title }}</strong>
              <small>{{ item.resource.name_zh || item.resource.file_name }}</small>
            </span>
            <span class="audio-queue-dur">{{ formatPosition(item.duration) || '' }}</span>
          </button>
          <button
            type="button"
            class="audio-queue-remove"
            :aria-label="'从清单移除 ' + item.title"
            title="从播放清单移除"
            @click="audio.removeFromQueue(item.id)"
          >
            <X :size="14" />
          </button>
        </li>
      </ul>
    </div>

    <audio
      ref="player"
      :src="audio.source"
      preload="metadata"
      @loadedmetadata="audio.loaded"
      @timeupdate="audio.position = player?.currentTime || 0"
      @play="audio.playing = true"
      @pause="audio.playing = false"
      @ended="audio.ended()"
      @error="
        audio.failure = audio.online
          ? '试听无法播放，请重新搜索或换来源重试。'
          : '此文件无法内置播放，可在详情中使用系统播放器打开。'
      "
    />
    <p v-if="audio.failure" class="audio-mini-error" role="alert">{{ audio.failure }}</p>
  </section>
</template>

<style scoped>
.audio-mini {
  position: relative;
  z-index: 70;
  flex-shrink: 0;
  min-height: 64px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border-top: 1px solid var(--divider);
  background: var(--bg-card);
  color: var(--text-main);
}
.audio-mini-icon {
  flex-shrink: 0;
  color: var(--accent);
}
.audio-mini > button,
.audio-mini-vol > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 6px;
  border-radius: 6px;
}
.audio-mini button:disabled {
  opacity: 0.35;
}
.audio-mini .audio-mini-title:disabled {
  opacity: 1;
}
.audio-mini > button:hover:not(:disabled),
.audio-mini-vol > button:hover:not(:disabled) {
  background: var(--hover-surface);
}
.audio-mini .audio-mini-title {
  display: grid;
  gap: 3px;
  text-align: left;
  justify-content: start;
  min-width: 80px;
  max-width: 240px;
  flex: 1;
}
.audio-mini-title strong,
.audio-mini-title small {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.audio-mini-title strong {
  font-size: 13px;
}
.audio-mini-title small,
.audio-mini-time {
  font-size: 11px;
  color: var(--text-sub);
  font-variant-numeric: tabular-nums;
}
.audio-mini-seek {
  min-width: 60px;
  flex: 1;
  accent-color: var(--accent);
  cursor: pointer;
}
.audio-mini-mode {
  color: var(--text-sub);
}
.audio-mini-vol {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.audio-mini-vol-slider {
  width: 68px;
  accent-color: var(--accent);
  cursor: pointer;
}
.audio-mini-queue-btn {
  gap: 5px;
  padding-inline: 8px !important;
  font-size: 12px;
  color: var(--text-sub);
  font-variant-numeric: tabular-nums;
}
.audio-mini-queue-btn.active {
  background: var(--active-surface);
  color: var(--accent);
}
.audio-queue-panel {
  position: absolute;
  right: 16px;
  bottom: calc(100% + 8px);
  width: min(380px, calc(100vw - 32px));
  max-height: min(420px, 60vh);
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--divider-strong);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  z-index: 90;
}
.audio-queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--divider);
}
.audio-queue-head strong {
  font-size: 13px;
}
.audio-queue-head span {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-sub);
}
.audio-queue-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.audio-queue-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
}
.audio-queue-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.audio-queue-item {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
}
.audio-queue-item:hover {
  background: var(--hover-surface);
}
.audio-queue-item.current {
  background: var(--active-surface);
  color: var(--accent);
}
.audio-queue-play {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  text-align: left;
}
.audio-queue-idx {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.audio-queue-item.current .audio-queue-idx {
  color: var(--accent);
}
.audio-queue-meta {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.audio-queue-meta strong,
.audio-queue-meta small {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.audio-queue-meta strong {
  font-size: 12px;
  font-weight: 500;
}
.audio-queue-meta small {
  font-size: 11px;
  color: var(--text-sub);
}
.audio-queue-dur {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.audio-queue-remove {
  flex: none;
  padding: 6px;
  border-radius: 5px;
  color: var(--text-faint);
}
.audio-queue-remove:hover {
  color: var(--danger);
  background: var(--hover-surface);
}
.audio-mini-error {
  position: absolute;
  bottom: 100%;
  left: 16px;
  background: var(--bg-card);
  border: 1px solid var(--divider);
  border-radius: 6px;
  color: var(--danger);
  font-size: 12px;
  padding: 8px 12px;
}
.audio-mini :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 900px) {
  .audio-mini-vol-slider {
    display: none;
  }
}
@media (max-width: 800px) {
  .audio-mini {
    padding: 8px 12px;
    gap: 6px;
  }
  .audio-mini-icon,
  .audio-mini-time {
    display: none;
  }
  .audio-mini .audio-mini-title {
    max-width: 150px;
  }
}
</style>
