<script setup lang="ts">
/**
 * 游戏库首页 —— v0.6 Step 1 的占位。
 *
 * 现在只是一张空状态：数据层（game_meta / save_backups）在 Step 2 建，
 * 封面墙和侧边栏在 Step 4。放一个诚实的空页，比放一个假的封面墙好 ——
 * 后者会让人以为扫描没扫到东西。
 */
import { Gamepad2 } from 'lucide-vue-next'
</script>

<template>
  <div class="game-home">
    <div class="empty">
      <Gamepad2 :size="30" />
      <h2>游戏库还没有开张</h2>
      <p>封面墙、存档备份、游玩时长正在建。这里暂时是空的。</p>
    </div>
  </div>
</template>

<style scoped>
.game-home {
  display: flex;
  height: 100%;
  min-height: 0;
}

.empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  color: var(--text-faint);
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
