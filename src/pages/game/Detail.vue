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
  BadgeCheck,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  HardDriveDownload,
  History,
  Link2,
  Loader2,
  RotateCcw,
  Save,
  Trash2
} from 'lucide-vue-next'
import EditableField from '@/components/ui/EditableField.vue'
import TagBadge from '@/components/ui/TagBadge.vue'
import { useToast } from '@/composables/useToast'
import { PLAY_STATUS_LABEL, useGameStore } from '@/stores/game'
import type { GameItem, PlayStatus, SaveBackup, SavePath } from '@/types'
import {
  errorMessage,
  formatBytes,
  formatDate,
  formatDateTime,
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

async function loadAll(): Promise<void> {
  await load()
  await loadBackups()
}

onMounted(loadAll)
watch(() => props.id, loadAll)

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

/* ---------------------------- 存档路径 ---------------------------- */

function removeSavePath(path: string): void {
  if (!item.value) return
  void save({ save_paths: item.value.save_paths.filter((s) => s.path !== path) })
}

/**
 * 加一条存档路径：选目录 → 主进程当场探测 → 落库。
 *
 * 空目录不直接拒绝，问一句就收下 —— 「存在但一个文件都没有」是个有意义的
 * 中间状态：游戏还没存过档，路径本身完全可能是对的。备份那一层照样会拒绝
 * 空目录，所以收下它不会导致「备份了一个空文件夹」那个后果。
 */
async function addSavePath(): Promise<void> {
  if (!item.value) return
  const check = await window.baoyi.game.pickSavePath()
  if (!check) return

  const already = item.value.save_paths.some(
    (s) => s.path.toLowerCase() === check.path.toLowerCase()
  )
  if (already) {
    toast('这条路径已经记下了')
    return
  }

  if (!check.exists) {
    error(`这个目录读不到：${check.path}`)
    return
  }
  if (check.files === 0) {
    const ok = window.confirm(
      `${check.path}\n\n这个目录现在一个文件都没有。` +
        `如果游戏还没存过档，路径可能是对的，记下来没问题；` +
        `但在它真的有存档之前，备份会拒绝执行。\n\n仍然记下这条路径吗？`
    )
    if (!ok) return
  }

  // verified_at 只在「确实看到文件」时才盖章，和 tools.ts 的 acceptSavePaths 同一个标准
  const next: SavePath[] = [
    ...item.value.save_paths,
    { path: check.path, verified_at: check.files > 0 ? Date.now() : 0 }
  ]
  await save({ save_paths: next })
  success(check.files > 0 ? `已记下，看到 ${check.files} 个文件` : '已记下这条路径')
}

const verifying = ref('')

/** 重新验一条。主进程验过了会自己把 verified_at 往前推，这里只负责把话说清楚 */
async function verifySavePath(target: string): Promise<void> {
  if (!item.value) return
  verifying.value = target
  try {
    const check = await window.baoyi.game.verifySavePath(item.value.id, target)
    if (!check.exists) {
      error('这个目录已经不在了。存档可能被挪走了，或者游戏卸载过')
    } else if (check.files === 0) {
      toast('目录还在，但里面一个文件都没有')
    } else {
      success(`还在，${check.files} 个文件，共 ${formatBytes(check.bytes)}`)
      await load()
    }
  } catch (err) {
    error(`验证失败：${errorMessage(err)}`)
  } finally {
    verifying.value = ''
  }
}

/* ---------------------------- 存档备份 ---------------------------- */

const backups = ref<SaveBackup[]>([])
/** 正在备份的那条存档路径，同时用来禁按钮 */
const backingUp = ref('')
const restoring = ref('')

async function loadBackups(): Promise<void> {
  if (!item.value) {
    backups.value = []
    return
  }
  try {
    backups.value = await window.baoyi.game.backups(item.value.id)
  } catch (err) {
    error(`读取备份列表失败：${errorMessage(err)}`)
  }
}

/**
 * 备份一条存档路径。
 *
 * 不给进度条：存档通常是几 MB，复制在一眨眼之间。按钮转起来 + 完成时一句话
 * 就够了，为它铺一条进度通道属于空转。真遇到几个 GB 的（RPG Maker 带截图、
 * 模拟器即时存档），转圈也不会让人以为界面死了。
 */
async function backupSave(target: string): Promise<void> {
  if (!item.value) return
  backingUp.value = target
  try {
    const r = await window.baoyi.game.backupSave(item.value.id, target)
    if (!r.ok) {
      error(r.message)
      return
    }
    await loadBackups()
    success(`${r.message}，共 ${formatBytes(r.backup?.size_bytes ?? 0)}`)
  } catch (err) {
    error(`备份没能跑起来：${errorMessage(err)}`)
  } finally {
    backingUp.value = ''
  }
}

/**
 * 还原一份备份。
 *
 * 确认文案里要写明「当前存档会先自动备份一份」—— 那是这个操作敢做的全部理由，
 * 用户看到它才知道点下去不是一条单行道。
 */
async function restore(b: SaveBackup): Promise<void> {
  const when = formatDateTime(b.created_at)
  const ok = window.confirm(
    `用「${when}」这份备份覆盖当前存档？\n\n` +
      `目标：${b.save_path}\n` +
      `这份备份：${b.file_count} 个文件，${formatBytes(b.size_bytes)}\n\n` +
      `当前存档会先自动备份一份，还原错了可以再还原回来。\n` +
      `游戏正在运行时请先关掉它，否则文件会被占用。`
  )
  if (!ok) return

  restoring.value = b.id
  try {
    const r = await window.baoyi.game.restoreBackup(b.id)
    await loadBackups()
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(`还原没能跑起来：${errorMessage(err)}`)
  } finally {
    restoring.value = ''
  }
}

async function dropBackup(b: SaveBackup): Promise<void> {
  const ok = window.confirm(
    `删除「${formatDateTime(b.created_at)}」这份备份？\n\n` +
      `${b.backup_dir}\n\n磁盘上的这份拷贝会被删掉，删了就找不回来了。`
  )
  if (!ok) return
  try {
    const r = await window.baoyi.game.deleteBackup(b.id)
    await loadBackups()
    if (r.ok) success(r.message)
    else error(r.message)
  } catch (err) {
    error(`删除失败：${errorMessage(err)}`)
  }
}

const openBackup = (b: SaveBackup): Promise<void> => window.baoyi.game.openBackup(b.id)

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
            存档路径。识别时进来的那些都经过 detect_save_path 验证（见
            kinds/game/tools.ts 的 acceptSavePaths），手工加的那些经过对话框 +
            当场探测。两条路都不接受「没验证过的路径」—— 备份一个不存在的目录，
            后果是用户以为自己有备份。
          -->
          <section class="panel">
            <h2 class="sec-title">
              <HardDriveDownload :size="14" />
              存档位置
              <button class="sec-title__act" @click="addSavePath">
                <FolderPlus :size="13" />
                添加
              </button>
            </h2>

            <ul v-if="item.save_paths.length > 0" class="paths">
              <li v-for="s in item.save_paths" :key="s.path" class="path">
                <button class="path__text mono truncate" :title="`${s.path}（点击复制）`" @click="copyPath(s.path)">
                  {{ s.path }}
                </button>
                <span class="path__note">
                  {{ s.verified_at ? `${formatDate(s.verified_at)} 验证过` : '未验证' }}
                </span>
                <button
                  class="path__act"
                  title="重新看一眼它还在不在"
                  :disabled="verifying === s.path"
                  @click="verifySavePath(s.path)"
                >
                  <component :is="verifying === s.path ? Loader2 : BadgeCheck" :size="13" :class="{ spin: verifying === s.path }" />
                </button>
                <!-- 一条存档路径可能是目录也可能是单个 .sav，文案不能替它认定形状 -->
                <button
                  class="path__act"
                  title="现在备份这份存档"
                  :disabled="backingUp === s.path"
                  @click="backupSave(s.path)"
                >
                  <component :is="backingUp === s.path ? Loader2 : Save" :size="13" :class="{ spin: backingUp === s.path }" />
                </button>
                <button class="path__del" title="这条不对，删掉" @click="removeSavePath(s.path)">
                  <Trash2 :size="13" />
                </button>
              </li>
            </ul>
            <p v-else class="hint">
              识别时没能找到存档目录。点「添加」指一个 —— 选完会当场看一眼里面有什么，
              确认是存档再记下来。有了它才谈得上备份。
            </p>
            <p v-if="item.save_paths.length > 0" class="hint">
              备份放在设置 › 数据管理里指定的目录，一次备一份，不会覆盖上一份。
            </p>
          </section>

          <!--
            备份列表。刻意不做自动备份和保留策略：备份是用户「我要留住这一刻」的
            动作，定时替他决定留哪几份、删哪几份，等于替他扔东西。
          -->
          <section v-if="backups.length > 0" class="panel">
            <h2 class="sec-title">
              <History :size="14" />
              存档备份
              <span class="sec-title__count">{{ backups.length }}</span>
            </h2>
            <ul class="backups">
              <li v-for="b in backups" :key="b.id" class="backup">
                <div class="backup__main">
                  <button
                    class="backup__when"
                    :title="`${b.backup_dir}（点击在资源管理器里打开）`"
                    @click="openBackup(b)"
                  >
                    {{ formatDateTime(b.created_at) }}
                  </button>
                  <span class="backup__meta">
                    {{ b.file_count }} 个文件　{{ formatBytes(b.size_bytes) }}
                  </span>
                  <span class="backup__from mono truncate" :title="b.save_path">{{ b.save_path }}</span>
                </div>
                <div class="backup__acts">
                  <button
                    class="btn btn--ghost btn--tiny"
                    :disabled="restoring === b.id"
                    @click="restore(b)"
                  >
                    <component :is="restoring === b.id ? Loader2 : RotateCcw" :size="13" :class="{ spin: restoring === b.id }" />
                    还原
                  </button>
                  <button class="path__del" title="删掉这份备份" @click="dropBackup(b)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
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

/* 小节标题右侧的动作，比 .btn 轻一档 —— 它是标题的一部分，不该抢注意力 */
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

.path__act {
  flex: none;
  color: var(--text-faint);
}
.path__act:hover:not(:disabled) {
  color: var(--accent);
}
.path__act:disabled {
  color: var(--text-faint);
  cursor: default;
}

.path__del {
  flex: none;
  color: var(--text-faint);
}
.path__del:hover {
  color: var(--danger);
}

/* ------------------------------- 备份列表 ------------------------------- */
.backups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.backup {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: var(--radius-input);
  background: var(--hover-surface);
}

.backup__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.backup__when {
  font-size: var(--fs-body);
  color: var(--text-main);
  font-variant-numeric: tabular-nums;
}
.backup__when:hover {
  color: var(--accent);
}

.backup__meta {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* 存档路径在第二行：一个游戏可以有好几条，列表上只看时间分不出备的是哪一条 */
.backup__from {
  flex-basis: 100%;
  min-width: 0;
  font-size: var(--fs-tag);
  color: var(--text-faint);
}

.backup__acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn--tiny {
  height: 24px;
  padding: 0 8px;
  font-size: var(--fs-tag);
}

/* 转圈。备份和还原都是几百毫秒到几秒，没有它就看不出点没点上 */
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
</style>
