<script setup lang="ts">
import { errorMessage } from '@/utils'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Download, Music2, Play, Search } from 'lucide-vue-next'
import ProjectDialog from '@/components/project/ProjectDialog.vue'
import { useMusic } from '@/composables/useMusic'
import { useAudioStore } from '@/stores/audio'
import { audioTracks } from '@/utils/audio'
import type { MusicJob, MusicSource, MusicTrack } from '@/types/music'

const music = useMusic()
const audio = useAudioStore()
const source = ref<MusicSource>('netease')
const query = ref('')
const rows = ref<MusicTrack[]>([])
const page = ref(1)
const busy = ref(false)
const error = ref('')
const directory = ref('')
const previewing = ref('')
const downloading = ref('')
let revision = 0
let disposed = false

onMounted(() => {
  void window.baoyi.music
    .directory()
    .then(value => (directory.value = value))
    .catch(e => (error.value = String(e)))
})
onBeforeUnmount(() => {
  disposed = true
  revision++
})

async function search(next = 1) {
  const own = ++revision
  busy.value = true
  error.value = ''
  try {
    const found = await window.baoyi.music.search(source.value, query.value, next)
    if (own === revision) {
      rows.value = found
      page.value = next
    }
  } catch (e) {
    if (own === revision) error.value = errorMessage(e)
  } finally {
    if (own === revision) busy.value = false
  }
}

function changeSource() {
  revision++
  previewing.value = ''
  rows.value = []
  page.value = 1
  busy.value = false
  error.value = ''
}

async function preview(track: MusicTrack) {
  previewing.value = track.key
  error.value = ''
  try {
    const value = await window.baoyi.music.preview(track.key)
    if (!disposed && previewing.value === track.key) audio.playOnline(value)
  } catch (e) {
    if (!disposed) error.value = errorMessage(e)
  } finally {
    if (previewing.value === track.key) previewing.value = ''
  }
}

async function download(track: MusicTrack) {
  downloading.value = track.key
  error.value = ''
  try {
    await window.baoyi.music.download(track.key)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    downloading.value = ''
  }
}

function completedJob(key: string): MusicJob | undefined {
  return music.jobs.value.find(job => job.track.key === key && job.status === 'completed' && !!job.resourceId)
}

async function playDownloaded(resourceId?: string) {
  if (!resourceId) return
  try {
    const [item, library] = await Promise.all([
      window.baoyi.video.get(resourceId),
      window.baoyi.video.library(resourceId)
    ])
    if (!item || !library) return
    const list = audioTracks(item, library)
    if (list[0]) await audio.play(list[0], list)
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function pick() {
  try {
    const value = await window.baoyi.music.pickDirectory()
    if (value) directory.value = value
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function retry(id: string) {
  try {
    await window.baoyi.music.retry(id)
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function cancel(id: string) {
  try {
    await window.baoyi.music.cancel(id)
  } catch (e) {
    error.value = errorMessage(e)
  }
}
</script>

<template>
  <ProjectDialog title="找音乐" @close="music.open.value = false">
    <form class="music-search" @submit.prevent="search()">
      <select v-model="source" aria-label="音乐平台" @change="changeSource">
        <option value="netease">网易云音乐</option>
        <option value="joox">JOOX</option>
        <option value="bilibili">哔哩哔哩</option>
        <option value="tencent" disabled>QQ 音乐（接口暂未开放）</option>
        <option value="kuwo" disabled>酷我（接口暂未开放）</option>
      </select>
      <input v-model="query" maxlength="160" aria-label="歌曲、歌手或专辑" placeholder="搜索歌曲、歌手或专辑" />
      <button class="pj-button pj-primary" :disabled="busy || !query.trim()">
        <Search :size="15" />{{ busy ? '搜索中…' : '搜索' }}
      </button>
    </form>
    <p class="music-note">
      音乐来源：GD 音乐台（music.gdstudio.xyz）。当前公开接口开放网易云、JOOX 和哔哩哔哩；QQ、酷我暂未开放。优先获取可用无损音质。
    </p>
    <p class="music-directory">保存到 {{ directory }} <button class="pj-button" @click="pick">更改目录</button></p>
    <p v-if="error" class="music-error" role="alert">{{ error }}</p>
    <div v-if="!rows.length && !busy" class="music-empty">
      <Music2 :size="30" />
      <p>{{ query ? '没有搜索结果，可换平台或关键词。' : '找到喜欢的音乐，先试听，再保存到我的音频。' }}</p>
    </div>
    <article v-for="track in rows" :key="track.key" class="music-row">
      <div>
        <strong>{{ track.title }}</strong>
        <p>{{ track.artists.join(' / ') || '未知歌手' }} · {{ track.album || '未知专辑' }}</p>
      </div>
      <button
        v-if="completedJob(track.key)"
        class="pj-button"
        :aria-label="'播放已下载 ' + track.title"
        @click="playDownloaded(completedJob(track.key)?.resourceId)"
      >
        <Play :size="15" />播放本地
      </button>
      <button
        v-else
        class="pj-button"
        :disabled="previewing === track.key"
        :aria-label="'试听 ' + track.title"
        @click="preview(track)"
      >
        <Play :size="15" />{{ previewing === track.key ? '加载中' : '试听' }}
      </button>
      <button
        class="pj-button"
        :disabled="
          downloading === track.key ||
          music.jobs.value.some(job => job.track.key === track.key && ['running', 'completed'].includes(job.status))
        "
        :aria-label="'下载 ' + track.title"
        @click="download(track)"
      >
        <Download :size="15" />{{ completedJob(track.key) ? '已入库' : '下载' }}
      </button>
    </article>
    <div v-if="rows.length || page > 1" class="music-pages">
      <button class="pj-button" :disabled="busy || page <= 1" @click="search(page - 1)">上一页</button>
      <span>第 {{ page }} 页</span>
      <button class="pj-button" :disabled="busy || rows.length < 20" @click="search(page + 1)">下一页</button>
    </div>
    <details v-if="music.jobs.value.length" open>
      <summary>音乐下载（{{ music.jobs.value.filter(job => job.status === 'running').length }} 项进行中）</summary>
      <article v-for="job in music.jobs.value" :key="job.id" class="music-job">
        <div class="music-job-head">
          <strong>{{ job.track.title }}</strong>
          <button
            v-if="job.status === 'completed' && job.resourceId"
            type="button"
            class="pj-button"
            @click="playDownloaded(job.resourceId)"
          >
            <Play :size="13" />立即播放
          </button>
        </div>
        <span>{{ job.message }}</span>
        <progress v-if="job.status === 'running'" :value="job.total ? job.received : undefined" :max="job.total || 1" />
        <button v-if="job.status === 'running'" class="pj-button" @click="cancel(job.id)">停止下载</button>
        <button v-else-if="job.status !== 'completed'" class="pj-button" @click="retry(job.id)">重试</button>
      </article>
    </details>
    <template #footer>
      <span class="music-note">关闭面板后下载继续，进度可在任务中心查看。</span>
      <button class="pj-button" @click="music.open.value = false">关闭</button>
    </template>
  </ProjectDialog>
</template>

<style scoped>
.music-search { display: flex; gap: 10px; }
.music-search input { flex: 1; min-width: 0; }
.music-search input, .music-search select { padding: 10px; border: 1px solid var(--divider); border-radius: 8px; background: var(--bg-card); color: var(--text-main); }
.music-note, .music-directory { font-size: 12px; color: var(--text-sub); line-height: 1.6; }
.music-directory { overflow-wrap: anywhere; }
.music-row { display: flex; align-items: center; gap: 8px; padding: 13px 0; border-bottom: 1px solid var(--divider); }
.music-row > div { flex: 1; min-width: 0; }
.music-row strong { font-size: 14px; }
.music-row p { margin: 5px 0 0; font-size: 12px; color: var(--text-sub); }
.music-empty { text-align: center; padding: 22px; color: var(--text-sub); font-size: 13px; }
.music-pages { display: flex; align-items: center; justify-content: center; gap: 14px; margin: 16px; }
.music-error { color: var(--danger); }
.music-job { display: grid; gap: 6px; font-size: 12px; padding: 12px 0; border-bottom: 1px solid var(--divider); }
.music-job-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.music-job span { color: var(--text-sub); overflow-wrap: anywhere; }
.music-job progress { width: 100%; accent-color: var(--accent); }
details { margin-top: 18px; }
summary { cursor: pointer; font-size: 13px; }
.music-search button, .music-row button, .music-job-head button { display: inline-flex; align-items: center; gap: 6px; }
</style>
