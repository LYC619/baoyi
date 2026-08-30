<script setup lang="ts">
/**
 * 影视库首页：海报墙 + 侧边栏。
 *
 * 和游戏那边一样只有网格，没有列表视图 —— 影视靠海报认，一行文字把唯一的
 * 识别线索扔了。
 *
 * 多一个「补海报」的按钮，游戏那边没有。原因是海报的来路和封面不同：扫描
 * 只把 TMDB 的相对路径记下来，真正下载留到用户看得见海报墙的时候。做成按钮
 * 而不是进页面自动跑，是因为那是一串没人按过的网络请求 —— 用户配的反代、
 * 按流量计费的网络，都不该由一次「打开影视库」来花。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { FolderPlus, ImageDown, Search, Settings, X } from 'lucide-vue-next'
import Sidebar from '@/components/video/Sidebar.vue'
import VideoCard from '@/components/video/VideoCard.vue'
import type { VideoQuery, VideoScanProgress } from '@/types'
import { recallScroll, rememberScroll } from '@/composables/useModules'
import { useToast } from '@/composables/useToast'
import { useVideoStore } from '@/stores/video'
import { debounce, errorMessage, shortenPath } from '@/utils'

const router = useRouter()
const store = useVideoStore()
const { toast, success, error } = useToast()

const content = ref<HTMLElement | null>(null)

const scanning = ref(false)
const progress = ref<VideoScanProgress | null>(null)
let unsubscribe: (() => void) | null = null

const SORTS: Array<{ value: NonNullable<VideoQuery['sort']>; label: string }> = [
  { value: 'added', label: '最近加入' },
  { value: 'year', label: '按年份' },
  { value: 'rating', label: '按评分' },
  { value: 'name', label: '按名称' }
]

onMounted(async () => {
  unsubscribe = window.baoyi.video.onProgress((p) => (progress.value = p))
  await store.reload()
  await nextTick()
  // 内容还没渲染时容器高度是 0，这时候设 scrollTop 会被浏览器吞掉
  if (content.value) content.value.scrollTop = recallScroll('video')
})

onBeforeUnmount(() => {
  if (content.value) rememberScroll('video', content.value.scrollTop)
  unsubscribe?.()
})

const busyText = computed(() => {
  const p = progress.value
  if (!p) return '准备中'
  if (p.phase === 'scanning') return `正在扫描 ${shortenPath(p.current, 40)}`
  return `识别 ${p.processed + 1}/${p.total}　${p.log || shortenPath(p.current, 32)}`
})

const busyPercent = computed(() => {
  const p = progress.value
  // 扫描阶段的总数要扫完才知道，这时候画一根瞎跳的进度条不如画一根空的
  if (!p || p.phase === 'scanning' || p.total === 0) return 0
  return Math.round((p.processed / p.total) * 100)
})

const onKeyword = debounce(() => void store.load(), 220)

function clearKeyword(): void {
  store.keyword = ''
  void store.load()
}

function open(id: string): void {
  void router.push({ name: 'video-detail', params: { id } })
}

const cancelScan = (): void => window.baoyi.video.cancel()

/* ------------------------------ 补海报 ------------------------------ */

const filling = ref(false)

/**
 * 把当前这一屏缺海报的补上。
 *
 * 只管当前列表，不是整库：用户看着哪一屏就补哪一屏，这样等待和收益在同一个
 * 视野里。整库补齐是一次不知道要跑多久的活，而它的结果用户当场看不到。
 */
async function fillPosters(): Promise<void> {
  const ids = store.missingPosters
  if (ids.length === 0) {
    toast('这一屏的海报都齐了')
    return
  }
  filling.value = true
  try {
    await store.fillPosters(ids)
    // 补完再数一次：还缺的就是三条来路都没找着的那些，得让用户知道剩下要手动来
    const left = store.missingPosters.length
    if (left === 0) success(`补齐了 ${ids.length} 张海报`)
    else if (left < ids.length) toast(`补上 ${ids.length - left} 张，还有 ${left} 张没找到`)
    else toast('一张也没补上。检查一下 TMDB 配置，或者在详情页手动选图')
  } finally {
    filling.value = false
  }
}

/* ------------------------------ 加影视 ------------------------------ */

/**
 * 加影视：选目录 → 扫 → 逐个交给 agent 识别 → 直接落库。
 *
 * 可用性判断问主进程要，不在这儿照抄一遍条件 —— 两处各写一份，改了一处
 * 就会出现「界面说能扫，扫下去没识别」。
 */
async function addVideos(): Promise<void> {
  const ready = await window.baoyi.video.readiness()
  if (!ready.ok) {
    toast(ready.message)
    void router.push({ name: 'settings', query: { tab: 'ai' } })
    return
  }
  // ok 但带话 = 降级。先问一句：没有 TMDB 的剧集刮不到季集表，
  // 而补一个 key 再扫比扫完再回头修便宜得多
  if (ready.message && !confirm(`${ready.message}\n\n继续扫描吗？`)) {
    void router.push({ name: 'settings', query: { tab: 'search' } })
    return
  }

  const dirs = await window.baoyi.video.pickDirectories()
  if (dirs.length === 0) return

  scanning.value = true
  progress.value = null
  try {
    const r = await window.baoyi.video.scan(dirs)
    await store.reload()

    if (r.candidates === 0) {
      toast('这些目录里没找到影视文件（没有视频，或者体积都小到像预告片）')
    } else if (r.registered > 0) {
      success(
        `识别出 ${r.registered} 部` +
          (r.episodes > 0 ? `、${r.episodes} 集` : '') +
          (r.skipped > 0 ? `，跳过 ${r.skipped} 个` : '') +
          (r.failed > 0 ? `，${r.failed} 个失败` : '')
      )
    } else {
      // 扫到了却一个都没进库，得说清楚是「都不是影视」还是「跑挂了」
      error(
        r.failed > 0
          ? `${r.candidates} 个条目全部识别失败，检查一下 AI 配置`
          : `扫到 ${r.candidates} 个条目，但 AI 认为都不是影视`
      )
    }
  } catch (err) {
    error(`扫描没能跑起来：${errorMessage(err)}`)
  } finally {
    scanning.value = false
    progress.value = null
  }
}

const emptyHint = computed(() => {
  if (store.keyword.trim()) return { title: '没有匹配的影视', desc: '换个关键词，或清空搜索' }
  if (store.selection.kind === 'status')
    return { title: `「${store.heading}」里还没有影视`, desc: '在详情页可以改观看状态' }
  if (store.selection.kind === 'type')
    return { title: `还没有${store.heading}`, desc: '换一格看看，或者点右上角加影视' }
  if (store.counts.all === 0)
    return { title: '影视库还是空的', desc: '点右上角「加影视」，指一个影视目录给它' }
  return { title: '这里还没有内容', desc: '换个分类看看' }
})
</script>

<template>
  <div class="home">
    <Sidebar />

    <main class="home__main">
      <header class="toolbar">
        <div class="toolbar__title">
          <h1>{{ store.heading }}</h1>
          <span class="toolbar__count">{{ store.items.length }}</span>
        </div>

        <div class="search">
          <Search :size="15" class="search__icon" />
          <input
            v-model="store.keyword"
            class="search__input"
            type="text"
            placeholder="搜索片名、简介、标签"
            @input="onKeyword"
          />
          <button v-if="store.keyword" class="search__clear" title="清空" @click="clearKeyword">
            <X :size="14" />
          </button>
        </div>

        <div class="toolbar__actions">
          <select v-model="store.sort" class="select" @change="store.load()">
            <option v-for="o in SORTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>

          <!-- 都齐了就不出现：一个按下去只会说「无事可做」的按钮不如不在 -->
          <button
            v-if="store.missingPosters.length > 0"
            class="btn btn--subtle"
            :disabled="filling"
            :title="`补 ${store.missingPosters.length} 张海报`"
            @click="fillPosters"
          >
            <ImageDown :size="15" />
            {{ filling ? '补海报…' : `补海报 ${store.missingPosters.length}` }}
          </button>

          <button class="btn btn--primary" :disabled="scanning" @click="addVideos">
            <FolderPlus :size="15" />
            加影视
          </button>

          <button class="btn btn--subtle" title="设置" @click="router.push({ name: 'settings' })">
            <Settings :size="16" />
          </button>
        </div>
      </header>

      <Transition name="fade">
        <div v-if="scanning" class="progress">
          <div class="progress__bar"><i :style="{ width: `${busyPercent}%` }" /></div>
          <span class="progress__text truncate">{{ busyText }}</span>
          <button class="btn btn--subtle" @click="cancelScan">停止</button>
        </div>
      </Transition>

      <section ref="content" class="home__content">
        <div v-if="store.items.length > 0" class="wall">
          <VideoCard v-for="v in store.items" :key="v.id" :item="v" @open="open" />
        </div>
        <div v-else-if="!store.loading" class="empty">
          <h2>{{ emptyHint.title }}</h2>
          <p>{{ emptyHint.desc }}</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  height: 100%;
  min-height: 0;
}

.home__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px 12px;
}

.toolbar__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 120px;
}

.toolbar__title h1 {
  font-size: var(--fs-title);
  font-weight: 500;
  white-space: nowrap;
}

.toolbar__count {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.search {
  position: relative;
  flex: 1;
  max-width: 420px;
  display: flex;
  align-items: center;
}

.search__icon {
  position: absolute;
  left: 10px;
  color: var(--text-faint);
}

.search__input {
  width: 100%;
  height: 30px;
  padding: 0 30px 0 32px;
  border-radius: var(--radius-input);
  background: var(--bg-card);
  border: 1px solid var(--card-border);
  color: var(--text-main);
  font-size: var(--fs-body);
  outline: none;
}
.search__input:focus {
  border-color: var(--accent);
}

.search__clear {
  position: absolute;
  right: 8px;
  color: var(--text-faint);
}
.search__clear:hover {
  color: var(--text-main);
}

.toolbar__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.select {
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-tag);
  background: var(--bg-card);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  font-size: var(--fs-tag);
  outline: none;
}

.progress {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 20px 12px;
  padding: 10px 14px;
  border-radius: var(--radius-input);
  background: var(--bg-card);
  border: 1px solid var(--card-border);
}

.progress__bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--hover-surface);
  overflow: hidden;
}

.progress__bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 200ms ease;
}

.progress__text {
  flex: none;
  max-width: 40%;
  font-size: var(--fs-tag);
  color: var(--text-sub);
}

.home__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 20px 24px;
}

/* 海报墙。和游戏封面墙同一个格子尺寸 —— 两个库并排看时格子不该跳 */
.wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px 14px;
  align-content: start;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  min-height: 280px;
  text-align: center;
}

.empty h2 {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 400;
  color: var(--text-sub);
}

.empty p {
  font-size: var(--fs-body);
  color: var(--text-faint);
}
</style>
