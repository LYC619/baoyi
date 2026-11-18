<script setup lang="ts">
import { onMounted, ref, version as vueVersion } from 'vue'
import { Github } from 'lucide-vue-next'
import BaoyiLogo from '@/components/ui/BaoyiLogo.vue'
import type { AppInfo } from '@/types'

/* -------------------------------- 关于 -------------------------------- */

const info = ref<AppInfo | null>(null)

onMounted(async () => {
  info.value = await window.baoyi.app.info()
})
</script>

<template>
<section class="panel about">
  <BaoyiLogo :size="52" />
  <div>
    <p class="about__name">
      抱一 <span class="about__ver mono">v{{ info?.version ?? '—' }}</span>
    </p>
    <p class="about__slogan">知止而后得。</p>
    <p class="about__quote">是以圣人抱一为天下式。——《道德经》第二十二章</p>
  </div>
</section>

<section class="panel">
  <h2 class="sec-head">这是什么</h2>
  <p class="sec-desc sec-desc--loose">
    抱一把散落在各个盘符里的绿色软件收拢成一面卡片墙，交给 AI 认清每一个是什么、
    能替你解决什么问题，再由你决定留下哪些。
  </p>
  <p class="sec-desc sec-desc--loose">
    不联网同步、不上传任何数据，所有记录都在本机。
  </p>
</section>

<section class="panel">
  <h2 class="sec-head">构建信息</h2>
  <dl class="kv">
    <dt>抱一</dt>
    <dd class="mono">v{{ info?.version ?? '—' }}</dd>
    <dt>Electron</dt>
    <dd class="mono">{{ info?.electron ?? '—' }}</dd>
    <dt>Chromium</dt>
    <dd class="mono">{{ info?.chrome ?? '—' }}</dd>
    <dt>Node</dt>
    <dd class="mono">{{ info?.node ?? '—' }}</dd>
    <dt>Vue</dt>
    <dd class="mono">{{ vueVersion }}</dd>
    <dt>分发方式</dt>
    <dd>{{ info?.portable ? '绿色版（数据在程序旁边）' : '装机版（数据在 AppData）' }}</dd>
  </dl>
  <p v-if="info?.portable" class="hint">
    整个文件夹可以直接拷走，库和封面海报都跟着 <code>data\</code> 走。
    删掉 <code>绿色版.txt</code> 会让抱一改用 AppData，届时 <code>data\</code>
    里的数据不会自动搬过去。
  </p>
</section>

<section class="panel">
  <h2 class="sec-head">项目主页</h2>
  <div class="row">
    <button class="btn btn--ghost" disabled title="仓库还没公开">
      <Github :size="14" />
      GitHub
    </button>
    <span class="hint">仓库地址确定后会填在这里。</span>
  </div>
</section>
</template>

<style scoped src="../settings.css"></style>
<style scoped>
/* 关于页的正文按段落读，不是控件旁边的补充说明 */
.sec-desc--loose {
  font-size: var(--fs-body);
  color: var(--text-sub);
  margin-bottom: 8px;
}

.sec-desc--loose:last-child {
  margin-bottom: 0;
}

.kv {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: var(--fs-body);
}

.kv dt {
  color: var(--text-faint);
  font-size: var(--fs-tag);
}

.kv dd {
  margin: 0;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
}

.about {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 22px;
}

.about__name {
  font-family: var(--font-display);
  font-size: 19px;
  letter-spacing: 3px;
}

.about__ver {
  font-size: 11px;
  letter-spacing: 0;
  color: var(--text-faint);
}

.about__slogan {
  font-family: var(--font-display);
  font-size: var(--fs-body);
  color: var(--text-sub);
  margin-top: 6px;
}

.about__quote {
  font-family: var(--font-display);
  font-size: 11px;
  color: var(--text-faint);
  margin-top: 6px;
}
</style>
