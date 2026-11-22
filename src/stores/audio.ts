import { errorMessage } from '@/utils'
import { useToast } from '@/composables/useToast'
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { AudioMetadata, AudioTrack } from '@/utils/audio'
import type { MusicPreview } from '@/types/music'

export type { AudioTrack } from '@/utils/audio'
export type AudioPlayMode = 'sequence' | 'loop' | 'one' | 'shuffle'

const PLAY_MODES: AudioPlayMode[] = ['sequence', 'loop', 'one', 'shuffle']
export const AUDIO_MODE_LABEL: Record<AudioPlayMode, string> = {
  sequence: '顺序播放',
  loop: '列表循环',
  one: '单曲循环',
  shuffle: '随机播放'
}

function readLocal(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch { /* best-effort */ }
}

export const useAudioStore = defineStore('audio', () => {
  const queue = shallowRef<AudioTrack[]>([])
  const current = shallowRef<AudioTrack | null>(null)
  const player = shallowRef<HTMLAudioElement | null>(null)
  const online = shallowRef<MusicPreview | null>(null)
  const playing = ref(false)
  const position = ref(0)
  const duration = ref(0)
  const failure = ref('')
  const music = shallowRef<AudioMetadata | null>(null)

  const savedMode = readLocal('baoyi.audio.mode')
  const mode = ref<AudioPlayMode>(
    savedMode && PLAY_MODES.includes(savedMode as AudioPlayMode) ? (savedMode as AudioPlayMode) : 'sequence'
  )
  const savedVol = Number(readLocal('baoyi.audio.volume'))
  const volume = ref(Number.isFinite(savedVol) && savedVol >= 0 && savedVol <= 1 ? savedVol : 1)
  const muted = ref(readLocal('baoyi.audio.muted') === '1')

  const source = computed(() =>
    online.value?.url || (current.value ? `baoyi://audio/${current.value.resource.id}/${current.value.episode}` : '')
  )
  const index = computed(() => queue.value.findIndex(track => track.id === current.value?.id))
  const canWrap = computed(() => (mode.value === 'loop' || mode.value === 'shuffle') && queue.value.length > 1)
  const hasPrevious = computed(() => index.value > 0 || canWrap.value)
  const hasNext = computed(() => (index.value >= 0 && index.value < queue.value.length - 1) || canWrap.value)

  let generation = 0

  function syncAudioSettings() {
    if (!player.value) return
    player.value.volume = volume.value
    player.value.muted = muted.value
  }

  function setVolume(value: number) {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1))
    volume.value = clamped
    if (clamped > 0 && muted.value) {
      muted.value = false
      writeLocal('baoyi.audio.muted', '0')
    }
    writeLocal('baoyi.audio.volume', String(clamped))
    syncAudioSettings()
  }

  function toggleMute() {
    muted.value = !muted.value
    writeLocal('baoyi.audio.muted', muted.value ? '1' : '0')
    syncAudioSettings()
  }

  function cycleMode() {
    const idx = PLAY_MODES.indexOf(mode.value)
    mode.value = PLAY_MODES[(idx + 1) % PLAY_MODES.length]
    writeLocal('baoyi.audio.mode', mode.value)
  }

  async function resume() {
    const own = generation
    syncAudioSettings()
    try {
      await player.value?.play()
    } catch {
      if (own === generation && (current.value || online.value)) {
        failure.value = online.value
          ? '试听无法播放，请重新搜索或换来源重试。'
          : '无法内置播放，请重试或在详情中使用系统播放器。'
      }
    }
  }

  async function play(track: AudioTrack, tracks?: AudioTrack[]) {
    if (track.available === false) {
      failure.value = '曲目文件缺失或磁盘未连接'
      return
    }
    online.value = null
    if (tracks) queue.value = tracks.filter(t => t.available !== false)
    else if (!queue.value.some(t => t.id === track.id)) queue.value = [...queue.value, track]
    if (current.value?.id === track.id) {
      await toggle()
      return
    }
    const own = ++generation
    player.value?.pause()
    playing.value = false
    failure.value = ''
    music.value = null
    position.value = 0
    duration.value = track.duration
    current.value = track
    try {
      const info = await window.baoyi.video.audioInfo(track.resource.id, track.episode)
      if (own === generation) music.value = info?.music || null
    } catch (cause) {
      if (own === generation) useToast().error(errorMessage(cause))
    }
  }

  function playOnline(track: MusicPreview) {
    generation++
    player.value?.pause()
    current.value = null
    queue.value = []
    online.value = track
    music.value = {
      title: track.title,
      artist: track.artist,
      album: track.album,
      track: 0,
      sampleRate: 0,
      bitDepth: 0,
      bitRate: 0
    }
    playing.value = false
    failure.value = ''
    position.value = 0
    duration.value = 0
  }

  async function toggle() {
    if (!current.value && !online.value) return
    if (player.value?.paused) await resume()
    else player.value?.pause()
  }

  function next(delta = 1) {
    const list = queue.value
    if (!list.length) {
      playing.value = false
      return
    }
    if (mode.value === 'shuffle' && list.length > 1) {
      const candidates = list.filter((_, i) => i !== index.value)
      const picked = candidates[Math.floor(Math.random() * candidates.length)]
      if (picked) void play(picked)
      return
    }
    if (mode.value === 'loop' && list.length > 0) {
      const base = index.value >= 0 ? index.value : 0
      const target = list[(base + delta + list.length) % list.length]
      if (target) void play(target)
      return
    }
    const track = list[index.value + delta]
    if (track) void play(track)
    else playing.value = false
  }

  function ended() {
    if (online.value) {
      playing.value = false
      return
    }
    if (mode.value === 'one' && current.value) {
      seek(0)
      void resume()
      return
    }
    next(1)
  }

  function enqueue(tracks: AudioTrack[], playNext = false): number {
    const incoming = tracks.filter(t => t.available !== false)
    if (!incoming.length) return 0
    if (!current.value && !online.value) {
      void play(incoming[0], incoming)
      return incoming.length
    }
    if (online.value) {
      void play(incoming[0], incoming)
      return incoming.length
    }
    const existingIds = new Set(queue.value.map(t => t.id))
    const fresh = incoming.filter(t => !existingIds.has(t.id))
    if (!fresh.length) return 0
    if (playNext && index.value >= 0) {
      const before = queue.value.slice(0, index.value + 1)
      const after = queue.value.slice(index.value + 1)
      queue.value = [...before, ...fresh, ...after]
    } else {
      queue.value = [...queue.value, ...fresh]
    }
    return fresh.length
  }

  function removeFromQueue(trackId: string) {
    const idx = queue.value.findIndex(t => t.id === trackId)
    if (idx < 0) return
    const nextList = queue.value.filter(t => t.id !== trackId)
    if (current.value?.id === trackId) {
      if (!nextList.length) {
        close()
        return
      }
      const nextTrack = nextList[Math.min(idx, nextList.length - 1)]
      queue.value = nextList
      void play(nextTrack)
    } else {
      queue.value = nextList
    }
  }

  function close() {
    generation++
    player.value?.pause()
    current.value = null
    online.value = null
    queue.value = []
    music.value = null
    playing.value = false
    position.value = 0
    duration.value = 0
    failure.value = ''
  }

  function seek(seconds: number) {
    if (player.value && Number.isFinite(seconds)) {
      try {
        player.value.currentTime = Math.max(0, Math.min(duration.value, seconds))
        position.value = player.value.currentTime
      } catch (cause) {
        useToast().error(errorMessage(cause))
      }
    }
  }

  async function loaded() {
    if ((!current.value && !online.value) || player.value?.getAttribute('src') !== source.value) return
    if (player.value && Number.isFinite(player.value.duration)) duration.value = player.value.duration
    syncAudioSettings()
    await resume()
  }

  function attach(value: HTMLAudioElement | null) {
    player.value = value
    syncAudioSettings()
  }

  // Privacy changes and library restore revoke media in the main process.
  const unsubscribeClosed = window.baoyi.video.preview.onClosed(close)
  const unsubscribeLibrary = window.baoyi.video.onLibraryChanged(async () => {
    const track = current.value
    const own = generation
    if (!track) return
    try {
      const [item, library] = await Promise.all([
        window.baoyi.video.get(track.resource.id),
        window.baoyi.video.library(track.resource.id)
      ])
      if (own !== generation) return
      const content = library.contents.find(value => value.id === track.episode)
      if (!item || (track.episode && !content)) {
        close()
        return
      }
      queue.value = queue.value.filter(
        value => value.resource.id !== item.id || !value.episode || library.contents.some(c => c.id === value.episode)
      )
    } catch (cause) {
      if (own === generation) {
        close()
        useToast().error(errorMessage(cause))
      }
    }
  })

  onScopeDispose(() => {
    unsubscribeClosed()
    unsubscribeLibrary()
    close()
  })

  return {
    queue,
    current,
    online,
    playing,
    position,
    duration,
    failure,
    music,
    mode,
    volume,
    muted,
    source,
    hasPrevious,
    hasNext,
    play,
    playOnline,
    toggle,
    next,
    ended,
    enqueue,
    removeFromQueue,
    cycleMode,
    setVolume,
    toggleMute,
    close,
    seek,
    loaded,
    attach
  }
})
