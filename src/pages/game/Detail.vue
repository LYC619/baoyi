<script setup lang="ts">
/**
 * 游戏详情页。
 *
 * 和软件详情页的分工不同：软件那页的重心是「我为什么留着它」（为什么选它 /
 * 使用场景 / 淘汰的同类），游戏这页的重心是「它在磁盘上的哪些地方」——
 * 主程序、存档、关联文件。存档那一块尤其要能看能改：Step 5 的备份直接吃它，
 * 识别时模型漏了或者认错了，用户得有地方纠正，而不是等备份备了个空目录。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  HardDriveDownload,
  Link2,
  Trash2
} from 'lucide-vue-next'
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useToast } from '@/composables/useToast'
import { PLAY_STATUS_LABEL, useGameStore } from '@/stores/game'
import type { GameItem, PlayStatus } from '@/types'
import {
  errorMessage,
  formatBytes,
  formatDate,
  formatPlaytime,
  formatRelative,
  gameTitle
} from '@/utils'

const props = defineProps<{ id: string }>()

const router = useRouter()
const store = useGameStore()
const { success, error, toast } = useToast()

const item = ref<GameItem | null>(null)
const loading = ref(true)

const STATUSES: PlayStatus[] = ['unplayed', 'playing', 'completed', 'shelved']

async function load(): Promise<void> {
  loading.value = true
  try {
    item.value = await window.baoyi.game.get(props.id)
  } catch (err) {
    error(`读取游戏失败：${errorMessage(err)}`)
    item.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.id, load)

const title = computed(() => (item.value ? gameTitle(item.value) : ''))
const initial = computed(() => title.value.trim().charAt(0).toUpperCase() || '?')

const hue = computed(() => {
  let h = 0
  for (const ch of title.value) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
})

/** 走 store 而不是直接调 IPC：卡片墙和侧边栏计数要跟着一起更新 */
async function save(patch: Partial<GameItem>): Promise<void> {
  if (!item.value) return
  try {
    const updated = await store.update(item.value.id, patch)
    if (updated) item.value = updated
  } catch (err) {
    error(`保存失败：${errorMessage(err)}`)
  }
}

function commitTags(raw: string): void {
  // 中英文逗号、顿号都认 —— 用户不该为了分隔符去猜我们想要哪一个
  const tags = [...new Set(raw.split(/[,，、]/).map((t) => t.trim()).filter(Boolean))].slice(0, 8)
  void save({ tags })
}

/**
 * 删掉一条存档路径。加不了新的 —— 手输一条没验证过的路径，和模型编一条
 * 是同一个后果（备份备了个不存在的目录）。Step 5 会带一个「选目录并当场
 * 验证」的入口进来，那时候才谈得上添加。
 */
function removeSavePath(path: string): void {
  if (!item.value) return
  void save({ save_paths: item.value.save_paths.filter((s) => s.path !== path) })
}

function toggleArchive(): void {
  if (!item.value) return
  void save({ is_archived: !item.value.is_archived })
}

async function reveal(): Promise<void> {
  if (!item.value) return
  await window.baoyi.game.revealInFolder(item.value.id)
}

function openOfficial(): void {
  if (item.value?.official_url) window.open(item.value.official_url, '_blank')
}

async function removeItem(): Promise<void> {
  if (!item.value) return
  if (!window.confirm(`确定把「${title.value}」从库里移除吗？\n磁盘上的游戏文件和已有的存档备份都不会被删。`)) {
    return
  }
  await store.remove(item.value.id)
  success('已从库里移除')
  void router.push({ name: 'game-home' })
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
      <button class="btn btn--ghost" @click="router.push({ name: 'game-home' })">返回封面墙</button>
    </div>

    <template v-else>
      <header class="head">
        <button class="btn btn--subtle" @click="router.back()">
          <ArrowLeft :size="16" />
          返回
        </button>

        <div class="head__actions">
          <button class="btn btn--ghost" @click="reveal">
            <FolderOpen :size="14" />
            打开所在文件夹
          </button>
          <button
            class="btn btn--ghost"
            :disabled="!item.official_url"
            :title="item.official_url || '暂无官网'"
            @click="openOfficial"
          >
            <ExternalLink :size="14" />
            官网
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
            <div class="hero__cover" :style="{ '--hue': hue }">
              <span>{{ initial }}</span>
            </div>

            <div class="hero__text">
              <input
                class="hero__name"
                :value="item.name_zh"
                placeholder="游戏名"
                @change="save({ name_zh: ($event.target as HTMLInputElement).value.trim() })"
              />
              <input
                class="hero__en"
                :value="item.name_en"
                placeholder="原名 / 英文名"
                @change="save({ name_en: ($event.target as HTMLInputElement).value.trim() })"
              />
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
                  :class="{ on: item.play_status === s }"
                  @click="save({ play_status: s })"
                >
                  {{ PLAY_STATUS_LABEL[s] }}
                </button>
              </div>
            </div>
          </section>

          <section class="panel">
            <h2 class="sec-title">简介</h2>
            <EditableField
              :model-value="item.description"
              multiline
              placeholder="讲的是什么、玩法是什么样的"
              @commit="save({ description: $event })"
            />
          </section>

          <!--
            存档路径。只有 detect_save_path 亲自验过、且当时确实有文件的路径才会
            出现在这里（见 kinds/game/tools.ts 的 acceptSavePaths），所以「空」
            是一个诚实的结论，不是「还没查」。
          -->
          <section class="panel">
            <h2 class="sec-title">
              <HardDriveDownload :size="14" />
              存档位置
            </h2>
            <ul v-if="item.save_paths.length > 0" class="paths">
              <li v-for="s in item.save_paths" :key="s.path" class="path">
                <button class="path__text mono truncate" :title="`${s.path}（点击复制）`" @click="copyPath(s.path)">
                  {{ s.path }}
                </button>
                <span class="path__note">
                  {{ s.verified_at ? `${formatDate(s.verified_at)} 验证过` : '未验证' }}
                </span>
                <button class="path__del" title="这条不对，删掉" @click="removeSavePath(s.path)">
                  <Trash2 :size="13" />
                </button>
              </li>
            </ul>
            <p v-else class="hint">
              识别时没能找到存档目录。存档备份（下一步要做的）会先用到这里 ——
              到时候会有一个「选目录并当场验证」的入口补上它。
            </p>
          </section>

          <section v-if="item.linked_files.length > 0" class="panel">
            <h2 class="sec-title">
              <Link2 :size="14" />
              关联文件
            </h2>
            <ul class="paths">
              <li v-for="f in item.linked_files" :key="f.path" class="path">
                <button class="path__text mono truncate" :title="`${f.path}（点击复制）`" @click="copyPath(f.path)">
                  {{ f.path }}
                </button>
                <span class="path__note">{{ f.label || f.type }}</span>
              </li>
            </ul>
          </section>

          <section class="panel">
            <h2 class="sec-title">个人笔记</h2>
            <EditableField
              :model-value="item.notes"
              multiline
              placeholder="进度、卡在哪、装了哪些 MOD…"
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
              placeholder="RPG / 动作 / 策略…"
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

          <section class="panel">
            <h2 class="sec-title">游玩</h2>
            <dl class="facts">
              <dt>时长</dt>
              <dd>{{ formatPlaytime(item.total_playtime_sec) }}</dd>
              <dt>上次游玩</dt>
              <dd>{{ item.last_played_at ? formatRelative(item.last_played_at) : '未玩过' }}</dd>
              <dt>加入</dt>
              <dd>{{ formatDate(item.created_at) }}</dd>
            </dl>
          </section>

          <section class="panel">
            <h2 class="sec-title">文件</h2>
            <dl class="facts">
              <dt>主程序</dt>
              <dd>
                <button class="mono truncate link" :title="`${item.path}（点击复制）`" @click="copyPath(item.path)">
                  {{ item.file_name }}
                </button>
              </dd>
              <dt>大小</dt>
              <dd>{{ formatBytes(item.file_size) }}</dd>
              <dt>目录</dt>
              <dd>
                <button class="mono truncate link" :title="`${item.source_dir}（点击复制）`" @click="copyPath(item.source_dir)">
                  {{ item.source_dir }}
                </button>
              </dd>
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

/* ------------------------------- 头部卡片 ------------------------------- */
.hero {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  padding: 20px;
}

.hero__cover {
  flex: none;
  width: 96px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card);
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-size: 34px;
  color: rgb(255 255 255 / 0.82);
  background: linear-gradient(
    155deg,
    hsl(var(--hue) 26% 26%),
    hsl(calc(var(--hue) + 28) 22% 15%)
  );
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

/* ------------------------------- 路径列表 ------------------------------- */
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

.path__del {
  flex: none;
  color: var(--text-faint);
}
.path__del:hover {
  color: var(--danger, #e06c75);
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
</style>
