<script setup lang="ts">
import { onMounted, ref, version as vueVersion } from 'vue'
import { Github } from 'lucide-vue-next'
import BaoyiLogo from '@/components/ui/BaoyiLogo.vue'
import type { AppInfo } from '@/types'
import { locale } from '@/i18n'
import { useToast } from '@/composables/useToast'
import { errorMessage } from '@/utils'

/* -------------------------------- 关于 -------------------------------- */

const info = ref<AppInfo | null>(null)

onMounted(async () => {
  info.value = await window.baoyi.app.info()
})
async function openPage(page: 'repository' | 'guide'): Promise<void> {
  const url = page === 'repository' ? 'https://github.com/LYC619/baoyi' : `https://github.com/LYC619/baoyi/blob/main/docs/site/${locale.value}/guide.md`
  try { await window.baoyi.app.openUrl(url) }
  catch (error) { useToast().error(errorMessage(error)) }
}
</script>

<template>
<section class="panel about">
  <BaoyiLogo :size="52" />
  <div>
    <p class="about__name">{{ $t("抱一") }}<span class="about__ver mono">v{{ info?.version ?? '—' }}</span>
    </p>
    <p class="about__slogan">{{ $t("知止而后得。") }}</p>
    <p class="about__quote">{{ $t("是以圣人抱一为天下式。——《道德经》第二十二章") }}</p>
  </div>
</section>

<section class="panel">
  <h2 class="sec-head">{{ $t("这是什么") }}</h2>
  <p class="sec-desc sec-desc--loose">{{ $t('抱一把文件、项目与个人记录放在同一个本地工作区，保留资料之间的关联。') }}</p>
  <p class="sec-desc sec-desc--loose">{{ $t('资料库保存在本机。使用 AI、联网搜索或在线来源时，相关请求会发送到你选择的服务。') }}</p>
</section>

<section class="panel">
  <h2 class="sec-head">{{ $t("构建信息") }}</h2>
  <dl class="kv">
    <dt>{{ $t("抱一") }}</dt>
    <dd class="mono">v{{ info?.version ?? '—' }}</dd>
    <dt>Electron</dt>
    <dd class="mono">{{ info?.electron ?? '—' }}</dd>
    <dt>Chromium</dt>
    <dd class="mono">{{ info?.chrome ?? '—' }}</dd>
    <dt>Node</dt>
    <dd class="mono">{{ info?.node ?? '—' }}</dd>
    <dt>Vue</dt>
    <dd class="mono">{{ vueVersion }}</dd>
    <dt>{{ $t("分发方式") }}</dt>
    <dd>{{ info?.portable ? $t('绿色版（数据在程序旁边）') : $t('装机版（数据在 AppData）') }}</dd>
  </dl>
  <p v-if="info?.portable" class="hint">{{ $t('绿色版可连同整个目录复制。移除 绿色版.txt 会改用 AppData；原 data\\ 中的数据不会自动搬迁。') }}</p>
</section>

<section class="panel">
  <h2 class="sec-head">{{ $t("项目主页") }}</h2>
  <div class="row">
    <button class="btn btn--ghost" @click="openPage('repository')">
      <Github :size="14" />
      GitHub
    </button>
    <button class="btn btn--ghost" @click="openPage('guide')">{{ $t('使用指南') }}</button>
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
