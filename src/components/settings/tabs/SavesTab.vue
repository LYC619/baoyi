<script setup lang="ts">
import { systemMessage, tr } from '../../../i18n/index.ts'

import { onMounted, ref, watch } from 'vue'
import { FolderOpen, FolderPlus, Link2, RotateCcw, Trash2 } from 'lucide-vue-next'
import { confirmDialog } from '@/composables/useDialog'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'
import type { GameItem, SaveBackup } from '@/types'

import { errorMessage, formatBytes, formatDateTime } from '@/utils'
const settings = useSettingsStore()

const { success, error } = useToast()

/**
 * 备份根的**实际生效值**，从主进程取而不是读 settings.save_backup_root ——
 * 那个字段为空时含义是「用默认」，而默认值要拼用户数据目录，渲染进程拼不出来。
 */
const backupRoot = ref('')
const rootError = ref('')
const orphans = ref<SaveBackup[]>([])
const games = ref<GameItem[]>([])
const rebindTargets = ref<Record<string, string>>({})
const busyId = ref('')

async function loadBackupRoot(): Promise<void> {
  try {
    rootError.value = ''
    backupRoot.value = await window.baoyi.data.saveBackupRoot()
  } catch (cause) {
    rootError.value = errorMessage(cause)
    error(rootError.value)
  }
}

async function loadOrphans(): Promise<void> {
  if (typeof window.baoyi.game?.orphanBackups !== 'function') return
  try {
    const [orphanRows, gameRows] = await Promise.all([
      window.baoyi.game.orphanBackups(),
      window.baoyi.game.list()
    ])
    orphans.value = orphanRows
    games.value = gameRows
    for (const b of orphanRows) {
      if (!rebindTargets.value[b.id] && b.game_name) {
        const matched = gameRows.find(
          (g) => (g.name_zh || g.name_en || g.file_name).toLowerCase() === b.game_name!.toLowerCase()
        )
        if (matched) rebindTargets.value[b.id] = matched.id
      }
    }
  } catch (cause) {
    error(errorMessage(cause))
  }
}

async function openOrphanDir(backup: SaveBackup): Promise<void> {
  try {
    await window.baoyi.game.openBackup(backup.id)
  } catch (cause) {
    error(errorMessage(cause))
  }
}

async function restoreOrphan(b: SaveBackup): Promise<void> {
  busyId.value = b.id
  try {
    const p = await window.baoyi.game.previewRestore(b.id, b.save_path)
    const lines = [
      [tr('新增'), p.added],
      [tr('替换'), p.changed],
      [tr('移出当前目录'), p.removed]
    ] as const
    const detail = lines
      .map(([label, files]) => `${label} ${files.length}: ${files.slice(0, 8).join(', ')}${files.length > 8 ? '…' : ''}`)
      .join('\n')
    const ok = await confirmDialog({
      title: tr('还原「{p0}」存档备份', { p0: formatDateTime(b.created_at) }),
      message: tr('目标：{p0}\n{p1}\n保持相同 {p2} 个文件\n\n还原前会先自动备份当前存档，请确认游戏已关闭。', {
        p0: p.target,
        p1: detail,
        p2: p.unchanged
      }),
      confirmText: tr('确认还原')
    })
    if (!ok) return
    const r = await window.baoyi.game.restoreBackup(b.id, p.target, p.expected)
    await loadOrphans()
    if (r.ok) success(systemMessage(r.message))
    else error(systemMessage(r.message))
  } catch (cause) {
    error(tr('还原未完成：{p0}', { p0: errorMessage(cause) }))
  } finally {
    busyId.value = ''
  }
}

async function rebindOrphan(b: SaveBackup): Promise<void> {
  const targetGameId = rebindTargets.value[b.id]
  if (!targetGameId) return
  busyId.value = b.id
  try {
    const r = await window.baoyi.game.rebindBackup(b.id, targetGameId)
    if (!r.ok) {
      error(systemMessage(r.message))
      return
    }
    await loadOrphans()
    success(systemMessage(r.message))
  } catch (cause) {
    error(errorMessage(cause))
  } finally {
    busyId.value = ''
  }
}

async function dropOrphan(b: SaveBackup): Promise<void> {
  const ok = await confirmDialog({
    title: tr('删除「{p0}」这份备份？', { p0: formatDateTime(b.created_at) }),
    message: tr('{p0}\n\n备份文件夹将移入系统回收站并移除记录。', { p0: b.backup_dir }),
    confirmText: tr('删除备份'),
    tone: 'danger'
  })
  if (!ok) return
  busyId.value = b.id
  try {
    const r = await window.baoyi.game.deleteBackup(b.id)
    if (!r.ok) {
      error(systemMessage(r.message))
      return
    }
    await loadOrphans()
    success(systemMessage(r.message))
  } catch (cause) {
    error(errorMessage(cause))
  } finally {
    busyId.value = ''
  }
}

const openBackupRoot = async (): Promise<void> => { try { await window.baoyi.data.openSaveBackupRoot() } catch (cause) { error(errorMessage(cause)) } }

/**
 * 换备份根。已有的备份**不搬** —— 库里每条记录存的是完整路径，搬走等于让
 * 一批记录同时指向不存在的目录；不搬则旧备份照样能还原，只是散在两个地方。
 */
async function pickBackupRoot(): Promise<void> {
  const dir = await window.baoyi.data.pickSaveBackupRoot()
  if (!dir) return
  await settings.patch({ save_backup_root: dir })
  await loadBackupRoot()
  success(tr("存档备份目录已保存"))
}

async function resetBackupRoot(): Promise<void> {
  await settings.patch({ save_backup_root: '' })
  await loadBackupRoot()
}

/**
 * 保留上限。走本地 ref 而不是直接 v-model 到 store：数字输入框中间态会经过空串和
 * NaN，直接绑上去等于每敲一个字符就往库里写一次不成立的值。
 */
const keep = ref(settings.settings.save_backup_keep)

async function saveKeep(): Promise<void> {
  // 空串必须先单独挡掉：`Number('')` 是 0，而 0 的含义是「不限」——
  // 直接往下走会把「把输入框删干净」理解成「关掉提示」，那是把手滑当成决定。
  // v-model.number 在解析不出数字时会把原始字符串留在这儿，所以这里可能是 '' 或 'abc'。
  const raw = String(keep.value ?? '').trim()
  const n = raw === '' ? Number.NaN : Math.trunc(Number(raw))
  const safe = Number.isFinite(n) && n >= 0 ? Math.min(n, 999) : 10
  keep.value = safe
  if (safe === settings.settings.save_backup_keep) return
  await settings.patch({ save_backup_keep: safe })
  success(safe > 0 ? tr("超过 {p0} 份时会提示", {p0: (safe)}) : tr("已改为不限份数"))
}

watch(() => settings.settings.save_backup_keep, (v) => { keep.value = v })
onMounted(() => {
  void loadBackupRoot()
  void loadOrphans()
})
</script>

<template>
<section class="panel">
  <h2 class="sec-head">{{ $t("存档备份目录") }}</h2>
  <div class="datadir">
    <span class="datadir__label">{{ $t("存放位置") }}</span>
    <button
      class="datadir__path mono truncate"
      :title="backupRoot || rootError"
      @click="openBackupRoot"
    >
      {{ backupRoot || rootError || $t('读取中…') }}
    </button>
    <button class="btn btn--subtle" :title="$t('在资源管理器中打开')" @click="openBackupRoot">
      <FolderOpen :size="14" />
    </button>
  </div>
  <p class="sec-desc">{{ $t("游戏详情页里「备份存档」复制出来的拷贝都放在这里，一次备份一个目录， 目录名是「游戏名_编号 / 时间戳_存档目录名」。抱一不自动备份， 超出保留上限时也只会问你一句，不会自己删。") }}</p>

  <div class="row">
    <button class="btn btn--ghost" @click="pickBackupRoot">
      <FolderPlus :size="14" />{{ $t("换一个位置") }}</button>
    <button
      v-if="settings.settings.save_backup_root"
      class="btn btn--subtle"
      @click="resetBackupRoot"
    >{{ $t("用默认位置") }}</button>
    <span class="hint">
      {{
        settings.settings.save_backup_root
          ? $t('已指定，改这里不会搬走已有的备份')
          : $t('当前用的是用户数据目录下的 save-backups')
      }}
    </span>
  </div>

  <div class="row">
    <input
      v-model.number="keep"
      class="input input--num"
      type="number"
      min="0"
      max="999"
      @blur="saveKeep"
    />
    <span class="hint">{{ $t("份保留上限") }}</span>
    <span class="hint">
      {{
        keep > 0
          ? $t('同一条存档路径超过 {p0} 份时，备份完问你要不要删掉最早的几份', {p0: keep})
          : $t('填 0 表示不限，永不提示')
      }}
    </span>
  </div>
</section>

<section v-if="orphans.length > 0" class="panel" style="margin-top: 16px">
  <h2 class="sec-head">{{ $t('未绑定游戏的保留备份（{p0}）', { p0: orphans.length }) }}</h2>
  <p class="sec-desc">{{ $t('移除游戏条目或清空识别数据后保留下来的存档备份。可直接还原回原存档路径、重新绑定到入库的游戏，或删除不再需要的备份。') }}</p>
  <div style="display: flex; flex-direction: column; gap: 10px">
    <div
      v-for="b in orphans"
      :key="b.id"
      style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-surface)"
    >
      <div style="min-width: 0; flex: 1 1 260px">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--text-sm)">
          <strong>{{ b.game_name || $t('未命名游戏') }}</strong>
          <span class="hint">{{ formatDateTime(b.created_at) }}</span>
          <span class="hint">{{ formatBytes(b.size_bytes) }} · {{ $t('{p0} 个文件', { p0: b.file_count }) }}</span>
          <span v-if="b.note" class="hint">· {{ b.note }}</span>
        </div>
        <div class="mono truncate hint" :title="b.save_path" style="margin-top: 4px">{{ b.save_path }}</div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
        <template v-if="games.length > 0">
          <select
            v-model="rebindTargets[b.id]"
            class="input"
            style="max-width: 180px; height: 28px; padding: 0 8px; font-size: var(--text-xs)"
            :disabled="busyId === b.id"
            :aria-label="$t('选择要绑定的游戏')"
          >
            <option :value="''">{{ $t('选择游戏…') }}</option>
            <option v-for="g in games" :key="g.id" :value="g.id">
              {{ g.name_zh || g.name_en || g.file_name }}
            </option>
          </select>
          <button
            type="button"
            class="btn btn--subtle"
            :disabled="!rebindTargets[b.id] || busyId === b.id"
            @click="rebindOrphan(b)"
          >
            <Link2 :size="13" />{{ $t('绑定') }}
          </button>
        </template>
        <button type="button" class="btn btn--subtle" :disabled="busyId === b.id" @click="openOrphanDir(b)">
          <FolderOpen :size="13" />{{ $t('打开目录') }}
        </button>
        <button type="button" class="btn btn--ghost" :disabled="busyId === b.id" @click="restoreOrphan(b)">
          <RotateCcw :size="13" />{{ $t('还原') }}
        </button>
        <button type="button" class="btn btn--subtle" :disabled="busyId === b.id" @click="dropOrphan(b)">
          <Trash2 :size="13" />{{ $t('删除') }}
        </button>
      </div>
    </div>
  </div>
</section>
</template>

<style scoped src="../settings.css"></style>
