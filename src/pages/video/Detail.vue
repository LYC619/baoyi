<script setup lang="ts">
/**
 * 影视详情页。
 *
 * 重心和另两个品类都不同：软件那页答的是「我为什么留着它」，游戏那页答的是
 * 「它在磁盘上的哪些地方」，这一页答的是「我看到哪儿了，还缺什么」。
 * 所以季集表是主角 —— 它同时承担两件事：追进度，和暴露缺集。
 *
 * 缺集要露面，不能只列手上有的文件。TMDB 说这季 16 集而用户手里 8 个，
 * 那 8 个空位是这一页最有用的信息之一（见 types 里 Episode.path 的注释）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Clapperboard,
  ExternalLink,
  FolderOpen,
  Image,
  ImageDown,
  ImageOff,
  Loader2,
  Star,
  Trash2
} from 'lucide-vue-next'
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useToast } from '@/composables/useToast'
import { WATCH_STATUS_LABEL, VIDEO_TYPE_LABEL, useVideoStore } from '@/stores/video'
import type { Episode, MediaTrack, VideoItem, WatchStatus } from '@/types'
import {
  episodeCode,
  errorMessage,
  formatBytes,
  formatDate,
  formatDuration,
  formatPosition,
  formatRelative,
  posterUrl,
  PROTECTED_FIELD_LABEL,
  videoTitle
} from '@/utils'

const props = defineProps<{ id: string }>()

const router = useRouter()
const store = useVideoStore()
const { success, error, toast } = useToast()

const item = ref<VideoItem | null>(null)
const episodes = ref<Episode[]>([])
const loading = ref(true)

/** 「想看」排第一：这一列是从没看过往看完走的顺序，和侧栏那组的排序理由不同 */
const STATUSES: WatchStatus[] = ['unwatched', 'watching', 'watched', 'dropped']

async function load(): Promise<void> {
  loading.value = true
  try {
    item.value = await window.baoyi.video.get(props.id)
    // 电影那边返回空数组，不用分支
    episodes.value = item.value ? await window.baoyi.video.episodes(props.id) : []
  } catch (err) {
    error(`读取影视条目失败：${errorMessage(err)}`)
    item.value = null
    episodes.value = []
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.id, load)

const title = computed(() => (item.value ? videoTitle(item.value) : ''))
const initial = computed(() => title.value.trim().charAt(0).toUpperCase() || '?')

const hue = computed(() => {
  let h = 0
  for (const ch of title.value) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})

const isSeries = computed(() => item.value?.video_type === 'series')

/** 「2019」或者「2019 – 2022」。还在播的剧只显示起点 */
const yearText = computed(() => {
  const v = item.value
  if (!v || !v.year) return ''
  if (v.end_year && v.end_year !== v.year) return `${v.year} – ${v.end_year}`
  return String(v.year)
})

/* ---------------------------- 海报 ---------------------------- */

const poster = computed(() =>
  item.value ? posterUrl(item.value.poster_path, item.value.updated_at) : ''
)

const posterBusy = ref(false)

/**
 * 三条来路依次试。判断在主进程里，这儿只负责把结果说清楚 ——
 * 「同目录找到了」和「从 TMDB 下的」对用户是两件事，消息由那边给。
 */
async function fetchPoster(): Promise<void> {
  if (!item.value || posterBusy.value) return
  posterBusy.value = true
  try {
    const r = await window.baoyi.video.fetchPoster(item.value.id)
    if (r.item) item.value = r.item
    store.merge(r.item)
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(`找海报失败：${errorMessage(err)}`)
  } finally {
    posterBusy.value = false
  }
}

async function pickPoster(): Promise<void> {
  if (!item.value) return
  const r = await window.baoyi.video.pickPoster(item.value.id)
  if (!r) return
  if (!r.ok) {
    error(r.message)
    return
  }
  if (r.item) item.value = r.item
  store.merge(r.item)
  success(r.message)
}

async function clearPoster(): Promise<void> {
  if (!item.value?.poster_path) return
  const ok = window.confirm(
    '撤掉这张海报？\n\n' +
      '会退回首字占位。你原来那张图不受影响，删掉的是抱一自己存的那份拷贝。'
  )
  if (!ok) return
  const updated = await window.baoyi.video.clearPoster(item.value.id)
  if (updated) item.value = updated
  store.merge(updated)
}

/* ---------------------------- 保存 ---------------------------- */

/** 走 store 而不是直接调 IPC：海报墙和侧边栏计数要跟着一起更新 */
async function save(patch: Partial<VideoItem>): Promise<void> {
  if (!item.value) return
  try {
    const updated = await store.update(item.value.id, patch)
    if (updated) item.value = updated
  } catch (err) {
    error(`保存失败：${errorMessage(err)}`)
  }
}

function commitTags(raw: string): void {
  // 中英文逗号、顿号都认，同游戏那边
  const tags = [
    ...new Set(
      raw
        .split(/[,，、]/)
        .map((t) => t.trim())
        .filter(Boolean)
    )
  ].slice(0, 8)
  void save({ tags })
}

function toggleArchive(): void {
  if (!item.value) return
  void save({ is_archived: !item.value.is_archived })
}

/* ------------------------- 改过的字段 ------------------------- */

/**
 * 用户改过、因而重扫时会被保留的字段。
 *
 * 兜底成裸字段名而不是丢掉：真漏了标签的时候，显示 `douban_rating` 也比
 * 那一行凭空消失好 —— 后者会让用户以为保护没生效。自检里有一条盯着别漏。
 */
const editedFields = computed(() =>
  (item.value?.user_edited ?? []).map((field) => ({
    field,
    label: PROTECTED_FIELD_LABEL[field] ?? field
  }))
)

/** 传空数组 = 全撤。不改值，只改「下次重扫要不要写这一栏」 */
async function unprotect(fields: string[]): Promise<void> {
  if (!item.value) return
  try {
    const updated = await store.restoreScraped(item.value.id, fields)
    if (updated) item.value = updated
  } catch (err) {
    error(`取消保留失败：${errorMessage(err)}`)
  }
}

/* ---------------------------- 季集表 ---------------------------- */

/** 按季分组。季号排序，季内按集号 —— 后端已经排好，这里只切段 */
const seasons = computed(() => {
  const map = new Map<number, Episode[]>()
  for (const e of episodes.value) {
    const list = map.get(e.season)
    if (list) list.push(e)
    else map.set(e.season, [e])
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, list]) => ({
      season,
      list,
      watched: list.filter((e) => e.watch_status === 'watched').length,
      missing: list.filter((e) => !e.path).length
    }))
})

const busyEpisode = ref('')

/**
 * 改一集的观看状态。
 *
 * 条目那一行跟着回来 —— 标完最后一集，整部剧会自动变成「看完」，
 * 而那句「3/12 集」和侧栏计数都长在条目上。分两趟拿的话中间会闪一个矛盾的数。
 */
async function setEpisodeStatus(e: Episode, status: WatchStatus): Promise<void> {
  if (busyEpisode.value) return
  busyEpisode.value = e.id
  try {
    const r = await window.baoyi.video.updateEpisode(e.id, { watch_status: status })
    if (r.episode) {
      const i = episodes.value.findIndex((x) => x.id === e.id)
      if (i >= 0) episodes.value[i] = r.episode
    }
    if (r.item) item.value = r.item
    store.merge(r.item)
    // 一集的状态变化会挪动整部剧在侧栏的位置
    void store.refreshCounts()
  } catch (err) {
    error(`改这一集失败：${errorMessage(err)}`)
  } finally {
    busyEpisode.value = ''
  }
}

/** 点一下切换看过 / 没看过。追剧时这是最高频的一个动作，不该要两步 */
function toggleEpisode(e: Episode): void {
  void setEpisodeStatus(e, e.watch_status === 'watched' ? 'unwatched' : 'watched')
}

const seasonBusy = ref(-1)

/**
 * 整季标记看完。
 *
 * 只动手上有文件的那些：缺文件的集标成「看完」是一句不成立的话，
 * 而它会让「12/16 集」这个数字失去意义 —— 用户下次看到的就不是缺集提醒了。
 */
async function markSeasonWatched(season: number, list: Episode[]): Promise<void> {
  const targets = list.filter((e) => e.path && e.watch_status !== 'watched')
  if (targets.length === 0) {
    toast('这一季手上有的都标过了')
    return
  }
  seasonBusy.value = season
  try {
    for (const e of targets) {
      const r = await window.baoyi.video.updateEpisode(e.id, { watch_status: 'watched' })
      if (r.episode) {
        const i = episodes.value.findIndex((x) => x.id === e.id)
        if (i >= 0) episodes.value[i] = r.episode
      }
      if (r.item) item.value = r.item
    }
    store.merge(item.value)
    void store.refreshCounts()
    success(`第 ${season} 季标了 ${targets.length} 集`)
  } catch (err) {
    error(`批量标记中断：${errorMessage(err)}`)
  } finally {
    seasonBusy.value = -1
  }
}

/* ---------------------------- 杂项 ---------------------------- */

const trackText = (t: MediaTrack): string =>
  [t.label || t.language || '未知', t.codec].filter(Boolean).join(' · ')

async function reveal(): Promise<void> {
  if (!item.value) return
  await window.baoyi.video.revealInFolder(item.value.id)
}

function openUrl(url: string): void {
  if (url) window.open(url, '_blank')
}

const tmdbUrl = computed(() => {
  const v = item.value
  if (!v?.tmdb_id) return ''
  return `https://www.themoviedb.org/${v.video_type === 'series' ? 'tv' : 'movie'}/${v.tmdb_id}`
})

const doubanUrl = computed(() =>
  item.value?.douban_id ? `https://movie.douban.com/subject/${item.value.douban_id}/` : ''
)

async function removeItem(): Promise<void> {
  if (!item.value) return
  const ok = window.confirm(
    `确定把「${title.value}」从库里移除吗？\n磁盘上的视频文件和字幕都不会被删。`
  )
  if (!ok) return
  await store.remove(item.value.id)
  success('已从库里移除')
  void router.push({ name: 'video-home' })
}

function copyPath(path: string): void {
  void window.baoyi.app.copyText(path)
  toast('路径已复制')
}
</script>

<template>
  <div class="detail">
    <div v-if="loading" class="detail__state">载入中…</div>
    <div v-else-if="!item" class="detail__state">
      <p>这条记录不存在或已被移除。</p>
      <button class="btn btn--ghost" @click="router.push({ name: 'video-home' })">
        返回海报墙
      </button>
    </div>

    <template v-else>
      <header class="head">
        <button class="btn btn--subtle" @click="router.back()">
          <ArrowLeft :size="16" />
          返回
        </button>

        <div class="head__actions">
          <!--
            没有「播放」按钮：播放和进度是 Step 7 的活。现在给一个能确实做到的
            「打开所在文件夹」，而不是一个点了没反应的播放键
          -->
          <button class="btn btn--ghost" @click="reveal">
            <FolderOpen :size="14" />
            打开所在文件夹
          </button>
          <button
            class="btn btn--ghost"
            :disabled="!tmdbUrl"
            :title="tmdbUrl || '没有 TMDB 条目'"
            @click="openUrl(tmdbUrl)"
          >
            <ExternalLink :size="14" />
            TMDB
          </button>
          <button
            class="btn btn--ghost"
            :disabled="!doubanUrl"
            :title="doubanUrl || '没匹配到豆瓣条目'"
            @click="openUrl(doubanUrl)"
          >
            <ExternalLink :size="14" />
            豆瓣
          </button>
          <button class="btn btn--ghost" @click="toggleArchive">
            <component :is="item.is_archived ? ArchiveRestore : Archive" :size="14" />
            {{ item.is_archived ? '取消归档' : '归档' }}
          </button>
          <button class="btn btn--danger" @click="removeItem">
            <Trash2 :size="14" />
            移除
          </button>
        </div>
      </header>

      <div class="body">
        <!-- ------------------------------ 主列 ------------------------------ -->
        <div class="col col--main">
          <section class="hero panel">
            <!-- 海报区自己是那几个按钮的入口，悬停才显形，同游戏详情页 -->
            <div class="hero__poster" :style="{ '--hue': hue }">
              <img v-if="poster" :src="poster" :alt="title" class="hero__img" />
              <span v-else class="hero__initial">{{ initial }}</span>

              <div class="hero__posterActs">
                <button
                  class="hero__posterBtn"
                  :disabled="posterBusy"
                  title="按顺序找：同目录的海报图 → 刮削时记下的 TMDB 图"
                  @click="fetchPoster"
                >
                  <Loader2 v-if="posterBusy" :size="13" class="spin" />
                  <ImageDown v-else :size="13" />
                  {{ posterBusy ? '找着' : '找海报' }}
                </button>
                <button
                  class="hero__posterBtn"
                  :title="item.poster_path ? '换一张海报' : '选一张海报图'"
                  @click="pickPoster"
                >
                  <Image :size="13" />
                  {{ item.poster_path ? '换' : '选图' }}
                </button>
                <button
                  v-if="item.poster_path"
                  class="hero__posterBtn"
                  title="撤掉海报，退回首字占位"
                  @click="clearPoster"
                >
                  <ImageOff :size="13" />
                </button>
              </div>
            </div>

            <div class="hero__text">
              <input
                class="hero__name"
                :value="item.name_zh"
                placeholder="片名"
                @change="save({ name_zh: ($event.target as HTMLInputElement).value.trim() })"
              />
              <input
                class="hero__en"
                :value="item.name_en"
                placeholder="原名 / 英文名"
                @change="save({ name_en: ($event.target as HTMLInputElement).value.trim() })"
              />

              <div class="hero__meta">
                <span class="hero__badge">
                  <Clapperboard :size="11" />
                  {{ VIDEO_TYPE_LABEL[item.video_type] }}
                </span>
                <span v-if="yearText">{{ yearText }}</span>
                <span v-if="item.resolution">{{ item.resolution }}</span>
                <span v-if="!isSeries && item.duration_sec > 0">
                  {{ formatDuration(item.duration_sec) }}
                </span>
                <!-- 两个评分并列且各自标出处：合成一个数就没法诚实说它是哪儿来的 -->
                <span v-if="item.rating > 0" class="hero__rating" title="TMDB 评分">
                  <Star :size="11" />
                  {{ item.rating.toFixed(1) }}
                </span>
                <span v-if="item.douban_rating > 0" class="hero__rating" title="豆瓣评分（搜索摘要里的快照，可能不是最新）">
                  豆 {{ item.douban_rating.toFixed(1) }}
                </span>
              </div>

              <input
                class="hero__summary"
                :value="item.summary"
                placeholder="一句话说明"
                @change="save({ summary: ($event.target as HTMLInputElement).value.trim() })"
              />

              <div class="statuses">
                <button
                  v-for="s in STATUSES"
                  :key="s"
                  class="chip"
                  :class="{ on: item.watch_status === s }"
                  @click="save({ watch_status: s })"
                >
                  {{ WATCH_STATUS_LABEL[s] }}
                </button>
              </div>
            </div>
          </section>

          <section class="panel">
            <h2 class="sec-title">简介</h2>
            <EditableField
              :model-value="item.description"
              multiline
              placeholder="讲的是什么"
              @commit="save({ description: $event })"
            />
          </section>

          <!--
            季集表。剧集才有，电影这一块整个不出现 ——
            一部电影没有「季集」这种东西，给它一张空表只会让人以为刮削漏了。
          -->
          <template v-if="isSeries">
            <section v-if="seasons.length > 0" class="panel">
              <h2 class="sec-title">
                季集
                <span class="sec-title__count">
                  {{ item.episode_watched }}/{{ item.episode_total }} 集
                </span>
              </h2>

              <div v-for="s in seasons" :key="s.season" class="season">
                <div class="season__head">
                  <span class="season__name">
                    {{ s.season === 0 ? '特别篇' : `第 ${s.season} 季` }}
                  </span>
                  <span class="season__meta">
                    {{ s.watched }}/{{ s.list.length }} 集看完
                    <template v-if="s.missing > 0">　缺 {{ s.missing }}</template>
                  </span>
                  <button
                    class="season__act"
                    :disabled="seasonBusy === s.season"
                    title="把这一季手上有的都标成看完（缺文件的不动）"
                    @click="markSeasonWatched(s.season, s.list)"
                  >
                    <component
                      :is="seasonBusy === s.season ? Loader2 : Check"
                      :size="12"
                      :class="{ spin: seasonBusy === s.season }"
                    />
                    整季标看完
                  </button>
                </div>

                <ul class="eps">
                  <li
                    v-for="e in s.list"
                    :key="e.id"
                    class="ep"
                    :class="{ 'ep--missing': !e.path, 'ep--watched': e.watch_status === 'watched' }"
                  >
                    <!-- 勾选框在最左：追剧时手指落点固定在同一列，不用每行找位置 -->
                    <button
                      class="ep__check"
                      :disabled="busyEpisode === e.id || !e.path"
                      :title="e.path ? '标记看过 / 没看过' : '这一集没有文件'"
                      @click="toggleEpisode(e)"
                    >
                      <Loader2 v-if="busyEpisode === e.id" :size="12" class="spin" />
                      <Check v-else-if="e.watch_status === 'watched'" :size="12" />
                    </button>

                    <span class="ep__code mono">{{ episodeCode(e.season, e.episode) }}</span>
                    <span class="ep__title truncate" :title="e.title">
                      {{ e.title || '（无标题）' }}
                    </span>

                    <!-- 缺文件的那些明说，这是这一页最有用的信息之一 -->
                    <span v-if="!e.path" class="ep__missing">缺文件</span>
                    <template v-else>
                      <span v-if="e.position_sec > 0" class="ep__pos" title="上次播到这里">
                        {{ formatPosition(e.position_sec) }}
                      </span>
                      <span v-if="e.duration_sec > 0" class="ep__dur">
                        {{ formatDuration(e.duration_sec) }}
                      </span>
                      <button
                        class="ep__path mono truncate"
                        :title="`${e.path}（点击复制）`"
                        @click="copyPath(e.path)"
                      >
                        {{ e.path.split(/[\\/]/).pop() }}
                      </button>
                    </template>
                  </li>
                </ul>
              </div>
            </section>

            <section v-else class="panel">
              <h2 class="sec-title">季集</h2>
              <p class="hint">
                还没有季集表。扫描时没配 TMDB 的话只会记下手上的文件，
                拿不到官方的季集列表 —— 也就看不出缺哪几集。
                在设置 › 搜索服务里填一个免费的 TMDB API Key，然后重扫这个目录可以补上。
              </p>
            </section>
          </template>

          <!-- 电影的分卷。CD1/CD2 那种，只有真的分卷了才出现 -->
          <section v-if="!isSeries && item.parts.length > 1" class="panel">
            <h2 class="sec-title">
              分卷
              <span class="sec-title__count">{{ item.parts.length }}</span>
            </h2>
            <ul class="paths">
              <li v-for="p in item.parts" :key="p.path" class="path">
                <span class="path__note">{{ p.label || '—' }}</span>
                <button
                  class="path__text mono truncate"
                  :title="`${p.path}（点击复制）`"
                  @click="copyPath(p.path)"
                >
                  {{ p.path.split(/[\\/]/).pop() }}
                </button>
                <span class="path__note">{{ formatBytes(p.file_size) }}</span>
              </li>
            </ul>
          </section>

          <section class="panel">
            <h2 class="sec-title">个人笔记</h2>
            <EditableField
              :model-value="item.notes"
              multiline
              placeholder="看到哪儿了、哪个版本、想说的话…"
              @commit="save({ notes: $event })"
            />
          </section>
        </div>

        <!-- ------------------------------ 侧列 ------------------------------ -->
        <div class="col col--side">
          <section class="panel">
            <h2 class="sec-title">分类</h2>
            <input
              class="input"
              :value="item.category"
              placeholder="剧情 / 科幻 / 纪录片…"
              @change="save({ category: ($event.target as HTMLInputElement).value.trim() })"
            />
          </section>

          <section class="panel">
            <h2 class="sec-title">标签</h2>
            <div v-if="item.tags.length > 0" class="tags">
              <TagBadge v-for="t in item.tags" :key="t" :label="t" />
            </div>
            <EditableField
              :model-value="item.tags.join('、')"
              placeholder="用「、」隔开，最多 8 个"
              @commit="commitTags"
            />
          </section>

          <!--
            改过的字段。只在真有改动时出现 —— 没改过任何东西的条目上，
            这一格是纯噪音。

            文案说的是「重扫时保留」而不是「已锁定」：用户要知道的是
            这个标记在什么时候起作用，而它只在重扫那一刻起作用。
          -->
          <section v-if="editedFields.length > 0" class="panel">
            <h2 class="sec-title">改过的字段</h2>
            <p class="panel__note">
              重扫时这几栏保持你改的值，不会被刮削覆盖。
            </p>
            <ul class="edited">
              <li v-for="f in editedFields" :key="f.field" class="edited__row">
                <span class="edited__name">{{ f.label }}</span>
                <button
                  class="edited__undo"
                  title="以后这一栏听刮削的（下次重扫才会变，不是现在）"
                  @click="unprotect([f.field])"
                >
                  取消保留
                </button>
              </li>
            </ul>
            <button
              v-if="editedFields.length > 1"
              class="edited__all"
              @click="unprotect([])"
            >
              全部取消保留
            </button>
          </section>

          <section class="panel">
            <h2 class="sec-title">观看</h2>
            <dl class="facts">
              <dt>状态</dt>
              <dd>{{ WATCH_STATUS_LABEL[item.watch_status] }}</dd>
              <template v-if="isSeries">
                <dt>进度</dt>
                <dd>
                  {{ item.episode_watched }}/{{ item.episode_total }} 集
                  <template v-if="item.episode_total > item.episode_present">
                    （缺 {{ item.episode_total - item.episode_present }}）
                  </template>
                </dd>
              </template>
              <template v-else-if="item.position_sec > 0">
                <dt>播到</dt>
                <dd>{{ formatPosition(item.position_sec) }}</dd>
              </template>
              <dt>上次观看</dt>
              <dd>{{ item.last_watched_at ? formatRelative(item.last_watched_at) : '没看过' }}</dd>
              <dt>加入</dt>
              <dd>{{ formatDate(item.created_at) }}</dd>
            </dl>
          </section>

          <!--
            这一块全是本地事实（文件名解析 + 容器元数据），不是模型猜的。
            读不出来的就不出现 —— 一行「未知」比没有这一行更让人以为哪里出错了。
          -->
          <section class="panel">
            <h2 class="sec-title">规格</h2>
            <dl class="facts">
              <template v-if="item.video_codec">
                <dt>编码</dt>
                <dd>{{ item.video_codec }}</dd>
              </template>
              <template v-if="item.source">
                <dt>片源</dt>
                <dd>{{ item.source }}</dd>
              </template>
              <template v-if="item.release_group">
                <dt>压制组</dt>
                <dd>{{ item.release_group }}</dd>
              </template>
              <template v-if="item.audio_tracks.length > 0">
                <dt>音轨</dt>
                <dd>{{ item.audio_tracks.map(trackText).join('，') }}</dd>
              </template>
              <template v-if="item.subtitle_tracks.length > 0">
                <dt>字幕</dt>
                <dd>{{ item.subtitle_tracks.map(trackText).join('，') }}</dd>
              </template>
              <dt>{{ isSeries ? '目录' : '文件' }}</dt>
              <dd>
                <button
                  class="mono truncate link"
                  :title="`${item.path}（点击复制）`"
                  @click="copyPath(item.path)"
                >
                  {{ item.file_name }}
                </button>
              </dd>
              <template v-if="item.file_size > 0">
                <dt>大小</dt>
                <dd>{{ formatBytes(item.file_size) }}</dd>
              </template>
            </dl>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.detail__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--text-sub);
}

.head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}

.head__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.body {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
  gap: 16px;
  padding: 20px 24px 32px;
  align-items: start;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
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

/* ------------------------------- 头部卡片 ------------------------------- */
.hero {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  padding: 20px;
}

/* 比游戏封面宽一点：影视海报上常有中文片名，96px 下那行字糊成一团 */
.hero__poster {
  position: relative;
  flex: none;
  width: 116px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card);
  overflow: hidden;
  display: grid;
  place-items: center;
  background: linear-gradient(
    155deg,
    hsl(var(--hue) 26% 26%),
    hsl(calc(var(--hue) + 28) 22% 15%)
  );
}

.hero__initial {
  font-family: var(--font-display);
  font-size: 40px;
  color: rgb(255 255 255 / 0.82);
}

.hero__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero__posterActs {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 4px;
  background: rgb(0 0 0 / 0.62);
  backdrop-filter: blur(4px);
  opacity: 0;
  transition: opacity var(--t-fast) ease;
}
.hero__poster:hover .hero__posterActs,
.hero__posterActs:focus-within {
  opacity: 1;
}

.hero__posterBtn {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-tag);
  color: rgb(255 255 255 / 0.86);
}
.hero__posterBtn:hover {
  color: #fff;
}

.hero__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hero__name,
.hero__en,
.hero__summary {
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: none;
  padding: 3px 6px;
  margin-left: -6px;
  color: inherit;
  transition: border-color var(--t-fast) ease;
}
.hero__name:hover,
.hero__en:hover,
.hero__summary:hover {
  border-color: var(--divider);
}
.hero__name:focus,
.hero__en:focus,
.hero__summary:focus {
  border-color: var(--accent);
}

.hero__name {
  font-size: 21px;
  font-weight: 500;
}

.hero__en {
  font-size: var(--fs-body);
  color: var(--text-faint);
}

.hero__summary {
  font-size: var(--fs-body);
  color: var(--text-sub);
}

/* 年份、分辨率、评分挤在一行：它们各自都太短，单独占行会把标题和简介推远 */
.hero__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.hero__badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: var(--radius-tag);
  background: var(--hover-surface);
  color: var(--text-sub);
}

.hero__rating {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--warning);
}

.statuses {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.chip {
  height: 26px;
  padding: 0 12px;
  border-radius: var(--radius-tag);
  font-size: var(--fs-tag);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease,
    border-color var(--t-fast) ease;
}
.chip:hover {
  color: var(--text-main);
}
.chip.on {
  background: var(--active-surface);
  border-color: transparent;
  color: var(--accent);
}

/* ------------------------------- 季集表 ------------------------------- */
.season + .season {
  margin-top: 16px;
}

.season__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px 6px;
  border-bottom: 1px solid var(--divider);
}

.season__name {
  font-size: var(--fs-body);
  color: var(--text-main);
}

.season__meta {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.season__act {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}
.season__act:hover:not(:disabled) {
  color: var(--accent);
}
.season__act:disabled {
  cursor: default;
}

.eps {
  display: flex;
  flex-direction: column;
}

.ep {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 4px;
  border-radius: var(--radius-btn);
}
.ep:hover {
  background: var(--hover-surface);
}

/*
 * 看过的整行压暗，而不是给个勾就完事：追剧时用户扫的是「哪一行还亮着」，
 * 那一行就是接着看的地方。逐行找勾要慢得多。
 */
.ep--watched .ep__code,
.ep--watched .ep__title {
  color: var(--text-faint);
}

/* 缺文件的行不压暗 —— 它是要被看见的，不是已经处理完的 */
.ep--missing .ep__title {
  color: var(--text-faint);
}

.ep__check {
  flex: none;
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: 4px;
  border: 1px solid var(--divider);
  color: var(--accent);
}
.ep__check:hover:not(:disabled) {
  border-color: var(--accent);
}
.ep__check:disabled {
  cursor: default;
  opacity: 0.45;
}

.ep__code {
  flex: none;
  width: 52px;
  font-size: var(--fs-tag);
  color: var(--text-sub);
}

.ep__title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  color: var(--text-main);
  text-align: left;
}

/* 警示色不做背景块：缺集很可能只是还没下，把它渲染成红底像是数据坏了 */
.ep__missing {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--warning);
}

.ep__pos,
.ep__dur {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.ep__pos {
  color: var(--accent);
}

.ep__path {
  flex: none;
  max-width: 30%;
  text-align: right;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}
.ep__path:hover {
  color: var(--text-sub);
}

/* ------------------------------- 分卷 ------------------------------- */
.paths {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.path {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-input);
  background: var(--hover-surface);
}

.path__text {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: var(--fs-tag);
  color: var(--text-sub);
}
.path__text:hover {
  color: var(--text-main);
}

.path__note {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.hint {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  line-height: 1.7;
}

/* ------------------------------- 侧列 ------------------------------- */
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
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
}

.link {
  max-width: 100%;
  text-align: left;
  color: var(--text-sub);
}
.link:hover {
  color: var(--accent);
}

/* --------------------------- 改过的字段 --------------------------- */
.panel__note {
  margin: -2px 0 10px;
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
</style>
