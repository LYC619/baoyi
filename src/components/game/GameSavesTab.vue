<script setup lang="ts">
import {
  BadgeCheck,
  FolderPlus,
  HardDriveDownload,
  History,
  Loader2,
  RotateCcw,
  Save,
  Trash2,
  Unlink,
} from 'lucide-vue-next'
import { projectOf } from '@/utils/game-project'
import { formatBytes, formatDate, formatDateTime } from '@/utils'
import type { GameItem, SaveBackup } from '@/types'

const props = defineProps<{
  item: GameItem
  backups: SaveBackup[]
  stalePaths: string[]
  verifying: string
  backingUp: string
  restoring: string
  restoreTargets: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'add-save-path'): void
  (e: 'copy-path', path: string): void
  (e: 'verify-save-path', path: string): void
  (e: 'backup-save', path: string): void
  (e: 'remove-save-path', path: string): void
  (e: 'open-backup', backup: SaveBackup): void
  (e: 'restore', backup: SaveBackup): void
  (e: 'drop-backup', backup: SaveBackup): void
  (e: 'update-restore-target', backupId: string, target: string | undefined): void
}>()

function isStale(target: string): boolean {
  return props.stalePaths.includes(target)
}
</script>

<template>
  <div
    id="game-panel-saves"
    role="tabpanel"
    aria-labelledby="game-tab-saves"
    tabindex="0"
    class="detail-panel detail-panel--saves"
  >
    <section class="panel">
      <p v-if="projectOf(item)?.saveScope" class="save-scope">{{ projectOf(item)?.saveScope }}</p>
      <p class="save-scope">
        下方仅列出你已指定的活跃存档位置；随附预设、测试档和安卓包中的文件不会自动作为玩家存档。多目录、注册表或浏览器存储需按单作工具说明备份。
      </p>
      <h2 class="sec-title">
        <HardDriveDownload :size="14" />
        存档位置
        <button type="button" class="sec-title__act" @click="emit('add-save-path')">
          <FolderPlus :size="13" />
          添加
        </button>
      </h2>

      <ul v-if="item.save_paths.length > 0" class="paths">
        <li v-for="s in item.save_paths" :key="s.path" class="path">
          <button
            type="button"
            class="path__text mono truncate"
            :title="`${s.path}（点击复制）`"
            @click="emit('copy-path', s.path)"
          >
            {{ s.path }}
          </button>
          <span
            v-if="isStale(s.path)"
            class="path__note path__note--stale"
            title="打开游戏库检查时发现该路径暂不可用，可能已移动、卸载，或所在磁盘尚未连接"
          >
            <Unlink :size="11" />
            路径失效
          </span>
          <span v-else class="path__note">
            {{ s.verified_at ? `${formatDate(s.verified_at)} 验证过` : '未验证' }}
          </span>
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            title="重新检查存档目录是否存在"
            :disabled="verifying === s.path"
            @click="emit('verify-save-path', s.path)"
          >
            <component
              :is="verifying === s.path ? Loader2 : BadgeCheck"
              :size="13"
              :class="{ spin: verifying === s.path }"
            />重新验证
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            title="立即备份这份存档"
            :disabled="!!backingUp || !!restoring"
            @click="emit('backup-save', s.path)"
          >
            <component
              :is="backingUp === s.path ? Loader2 : Save"
              :size="13"
              :class="{ spin: backingUp === s.path }"
            />立即备份
          </button>
          <button
            type="button"
            class="path__del"
            title="移除这条存档路径"
            @click="emit('remove-save-path', s.path)"
          >
            <Trash2 :size="13" />
          </button>
        </li>
      </ul>
      <p v-else class="hint">
        尚未登记存档目录。点击右上角「添加」指定一个目录，系统会当场检查其中的文件情况；确认后再开启备份。
      </p>
      <p v-if="item.save_paths.length > 0" class="hint">
        存档备份存放在「设置 › 游戏 › 存档与备份」指定的目录中，每次独立保存一份，不会覆盖历史备份。超出保留上限时会询问是否清理最早的旧备份。
      </p>
    </section>

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
              type="button"
              class="backup__when"
              :title="`${b.backup_dir}（点击打开备份文件夹）`"
              @click="emit('open-backup', b)"
            >
              {{ formatDateTime(b.created_at) }}
            </button>
            <span class="backup__meta">
              {{ b.file_count }} 个文件　{{ formatBytes(b.size_bytes) }}
            </span>
            <span class="backup__from mono truncate" :title="b.save_path">{{ b.save_path }}</span>
          </div>
          <div class="backup__acts">
            <label>
              还原到
              <select
                aria-label="还原目标"
                :value="restoreTargets[b.id] ?? ''"
                :disabled="!!backingUp || !!restoring"
                @change="
                  emit(
                    'update-restore-target',
                    b.id,
                    ($event.target as HTMLSelectElement).value || undefined
                  )
                "
              >
                <option value="">原位置：{{ b.save_path }}</option>
                <option
                  v-for="s in item.save_paths.filter((s) => s.path !== b.save_path)"
                  :key="s.path"
                  :value="s.path"
                >
                  {{ s.path }}
                </option>
              </select>
            </label>
            <button
              type="button"
              class="btn btn--ghost btn--tiny"
              :disabled="!!backingUp || !!restoring"
              @click="emit('restore', b)"
            >
              <component
                :is="restoring === b.id ? Loader2 : RotateCcw"
                :size="13"
                :class="{ spin: restoring === b.id }"
              />
              还原
            </button>
            <button
              type="button"
              class="path__del"
              :disabled="!!backingUp || !!restoring"
              title="删掉这份备份"
              @click="emit('drop-backup', b)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--text-sub);
}
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
.save-scope {
  font-size: var(--fs-tag);
  color: var(--text-sub);
  line-height: 1.7;
  margin-bottom: 10px;
}
.paths,
.backups {
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
.path__note--stale {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--warning);
}
.path__del {
  flex: none;
  color: var(--text-faint);
}
.path__del:hover {
  color: var(--danger);
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
  flex-wrap: wrap;
  gap: 8px;
}
.backup__acts label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  max-width: 240px;
}
.backup__acts select {
  max-width: 100%;
  background: var(--bg-main);
  color: var(--text-sub);
  border: 1px solid var(--divider);
  border-radius: 4px;
  padding: 4px;
}
.btn--tiny {
  height: 24px;
  padding: 0 8px;
  font-size: var(--fs-tag);
}
.hint {
  font-size: var(--fs-tag);
  color: var(--text-faint);
  line-height: 1.7;
  margin-top: 8px;
}
.spin {
  animation: spin 900ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<style scoped src="../../pages/game/detail-v21.css" />
