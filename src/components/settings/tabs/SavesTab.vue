<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { FolderOpen, FolderPlus } from 'lucide-vue-next'
import { useToast } from '@/composables/useToast'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()

const { success } = useToast()

/**
 * 备份根的**实际生效值**，从主进程取而不是读 settings.save_backup_root ——
 * 那个字段为空时含义是「用默认」，而默认值要拼用户数据目录，渲染进程拼不出来。
 */
const backupRoot = ref('')

async function loadBackupRoot(): Promise<void> {
  backupRoot.value = await window.baoyi.data.saveBackupRoot()
}

const openBackupRoot = (): Promise<string> => window.baoyi.data.openSaveBackupRoot()

/**
 * 换备份根。已有的备份**不搬** —— 库里每条记录存的是完整路径，搬走等于让
 * 一批记录同时指向不存在的目录；不搬则旧备份照样能还原，只是散在两个地方。
 */
async function pickBackupRoot(): Promise<void> {
  const dir = await window.baoyi.data.pickSaveBackupRoot()
  if (!dir) return
  await settings.patch({ save_backup_root: dir })
  await loadBackupRoot()
  success('存档备份目录已保存')
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
  success(safe > 0 ? `超过 ${safe} 份时会提示` : '已改为不限份数')
}

watch(() => settings.settings.save_backup_keep, (v) => { keep.value = v })
onMounted(loadBackupRoot)
</script>

<template>
<section class="panel">
  <h2 class="sec-head">存档备份目录</h2>
  <div class="datadir">
    <span class="datadir__label">存放位置</span>
    <button
      class="datadir__path mono truncate"
      :title="backupRoot"
      @click="openBackupRoot"
    >
      {{ backupRoot || '读取中…' }}
    </button>
    <button class="btn btn--subtle" title="在资源管理器中打开" @click="openBackupRoot">
      <FolderOpen :size="14" />
    </button>
  </div>
  <p class="sec-desc">
    游戏详情页里「备份存档」复制出来的拷贝都放在这里，一次备份一个目录，
    目录名是「游戏名_编号 / 时间戳_存档目录名」。抱一不自动备份，
    超出保留上限时也只会问你一句，不会自己删。
  </p>

  <div class="row">
    <button class="btn btn--ghost" @click="pickBackupRoot">
      <FolderPlus :size="14" />
      换一个位置
    </button>
    <button
      v-if="settings.settings.save_backup_root"
      class="btn btn--subtle"
      @click="resetBackupRoot"
    >
      用默认位置
    </button>
    <span class="hint">
      {{
        settings.settings.save_backup_root
          ? '已指定，改这里不会搬走已有的备份'
          : '当前用的是用户数据目录下的 save-backups'
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
    <span class="hint">份保留上限</span>
    <span class="hint">
      {{
        keep > 0
          ? `同一条存档路径超过 ${keep} 份时，备份完问你要不要删掉最早的几份`
          : '填 0 表示不限，永不提示'
      }}
    </span>
  </div>
</section>
</template>

<style scoped src="../settings.css"></style>
