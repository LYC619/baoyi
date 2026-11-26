<script setup lang="ts">
import { tr } from "../i18n/index.ts"

import { computed, ref, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { activeModule, lastNonSettingsPath, moduleTarget, MODULE_TABS, type ModuleKey } from '@/composables/useModules'
import { returnPath } from '@/utils/workspace-api'
import { ArrowLeft, Bot, Database, Download, Eye, FolderTree, Globe, Info, Palette, ScrollText, Tags, Telescope } from 'lucide-vue-next'
import ProjectSettings from '@/components/project/ProjectSettings.vue'
import PersonalSettings from '@/components/personal/PersonalSettings.vue'
import ModulePreferences from '@/components/workspace/ModulePreferences.vue'
import DocumentSettings from '@/components/workspace/DocumentSettings.vue'
import ImageSettings from '@/components/settings/ImageSettings.vue'
import VideoTaxonomySettings from '@/components/settings/VideoTaxonomySettings.vue'
import ScanTab from '@/components/settings/tabs/ScanTab.vue'
import OrganizeTab from '@/components/settings/tabs/OrganizeTab.vue'
import AiTab from '@/components/settings/tabs/AiTab.vue'
import ProxyTab from '@/components/settings/tabs/ProxyTab.vue'
import SearchTab from '@/components/settings/tabs/SearchTab.vue'
import MetadataTab from '@/components/settings/tabs/MetadataTab.vue'
import DownloadsTab from '@/components/settings/tabs/DownloadsTab.vue'
import NetworkTab from '@/components/settings/tabs/NetworkTab.vue'
import HentaiTab from '@/components/settings/tabs/HentaiTab.vue'
import AppearanceTab from '@/components/settings/tabs/AppearanceTab.vue'
import TaxonomyTab from '@/components/settings/tabs/TaxonomyTab.vue'
import LogsTab from '@/components/settings/tabs/LogsTab.vue'
import SavesTab from '@/components/settings/tabs/SavesTab.vue'
import DataTab from '@/components/settings/tabs/DataTab.vue'
import AboutTab from '@/components/settings/tabs/AboutTab.vue'

const route = useRoute()
const router = useRouter()

const MODULE_LABELS: Record<ModuleKey, string> = {
  get software() { return tr('软件') },
  get game() { return tr('游戏') },
  get video() { return tr('影视') },
  get image() { return tr('图片') },
  get project() { return tr('项目') },
  get document() { return tr('文库') },
  get personal() { return tr('个人') }
}

const GLOBAL_TABS = ['appearance', 'ai', 'proxy', 'search', 'data', 'about']

const globalScope = computed(
  () => route.query.scope === 'global' || (!route.query.scope && GLOBAL_TABS.includes(String(route.query.tab)))
)

const ALL_TABS = [
  { id: 'personal', get label() { return tr("个人设置") }, icon: Tags, modules: ['personal'] },
  { id: 'project', get label() { return tr("项目偏好") }, icon: FolderTree, modules: ['project'] },
  { id: 'scan', get label() { return tr("扫描与识别") }, icon: Telescope, modules: ['software', 'game', 'video', 'image', 'document'] },
  { id: 'organize', get label() { return tr("目录整理") }, icon: FolderTree, modules: ['software', 'video', 'image', 'document'] },
  { id: 'categories', get label() { return tr("分类") }, icon: FolderTree, modules: ['software', 'game', 'video', 'image', 'document', 'project'] },
  { id: 'groups', get label() { return tr("分组") }, icon: FolderTree, modules: ['document'] },
  { id: 'tags', get label() { return tr("标签") }, icon: Tags, modules: ['software', 'game', 'video', 'image', 'document', 'project'] },
  { id: 'saves', get label() { return tr("存档与备份") }, icon: Database, modules: ['game'] },
  { id: 'reader', get label() { return tr("阅读偏好") }, icon: Eye, modules: ['image', 'document'] },
  { id: 'metadata', get label() { return tr("影视刮削") }, icon: Telescope, modules: ['video'] },
  { id: 'logs', get label() { return tr("识别日志") }, icon: ScrollText, modules: ['software', 'game', 'video'] },
  { id: 'hentai', get label() { return tr("里番区基础设置") }, icon: Eye, modules: ['video'] },
  { id: 'network', get label() { return tr("网络与出站代理") }, icon: Globe, modules: ['video'] },
  { id: 'downloads', get label() { return tr("下载与缓存") }, icon: Download, modules: ['video'] },
  { id: 'hentai-groups', get label() { return tr("里番分组") }, icon: FolderTree, modules: ['video'] },
  { id: 'hentai-tags', get label() { return tr("里番标签") }, icon: Tags, modules: ['video'] },
  { id: 'appearance', get label() { return tr("外观") }, icon: Palette, modules: [] },
  { id: 'ai', get label() { return tr("AI 配置") }, icon: Bot, modules: [] },
  { id: 'proxy', get label() { return tr("网络代理") }, icon: Globe, modules: [] },
  { id: 'search', get label() { return tr("联网搜索") }, icon: Globe, modules: [] },
  { id: 'data', get label() { return tr("数据管理") }, icon: Database, modules: [] },
  { id: 'about', get label() { return tr("关于") }, icon: Info, modules: [] }
] as const

const moduleTabs = computed(() =>
  ALL_TABS.filter((t) => !GLOBAL_TABS.includes(t.id) && (t.modules as readonly string[]).includes(activeModule.value))
)
const globalTabs = computed(() => ALL_TABS.filter((t) => GLOBAL_TABS.includes(t.id)))
const TABS = computed(() =>
  globalScope.value ? [...globalTabs.value, ...moduleTabs.value] : [...moduleTabs.value, ...globalTabs.value]
)

type TabId = (typeof ALL_TABS)[number]['id']

function tabFromRoute(value: unknown): TabId {
  const raw = String(Array.isArray(value) ? value[0] : (value ?? ''))
  const id = (
    ({ online: 'network', taxonomy: 'categories', image: 'reader', document: 'scan' } as Record<string, string>)[raw] ||
    raw
  ) as TabId
  const availableTabs = TABS.value
  return availableTabs.some((t) => t.id === id) ? id : availableTabs[0]?.id ?? 'scan'
}

const tab = ref<TabId>(tabFromRoute(route.query.tab))

function go(id: TabId): void {
  tab.value = id
  void router.replace({
    name: 'settings',
    query: {
      ...(route.query.from ? { from: route.query.from } : {}),
      tab: id,
      module: activeModule.value,
      scope: GLOBAL_TABS.includes(id) ? 'global' : 'module'
    }
  })
}

function switchScope(module: ModuleKey | 'global'): void {
  void router.replace({
    name: 'settings',
    query:
      module === 'global'
        ? {
            ...(route.query.from ? { from: route.query.from } : {}),
            scope: 'global',
            module: activeModule.value,
            tab: 'appearance'
          }
        : {
            ...(route.query.from ? { from: route.query.from } : {}),
            scope: 'module',
            module
          }
  })
}

const returnTarget = computed(
  () => returnPath(route.query.from, '') || lastNonSettingsPath.value || moduleTarget(activeModule.value)
)

watch(
  () => [route.query.tab, activeModule.value, route.query.scope],
  ([v]) => (tab.value = tabFromRoute(v))
)

const tabComponent = computed(() =>
  !globalScope.value && ['image', 'document'].includes(activeModule.value)
    ? undefined
    : (
        {
          scan: ScanTab,
          organize: OrganizeTab,
          ai: AiTab,
          proxy: ProxyTab,
          search: SearchTab,
          metadata: MetadataTab,
          downloads: DownloadsTab,
          network: NetworkTab,
          hentai: HentaiTab,
          appearance: AppearanceTab,
          categories: TaxonomyTab,
          tags: TaxonomyTab,
          logs: LogsTab,
          saves: SavesTab,
          data: DataTab,
          about: AboutTab
        } as Partial<Record<TabId, Component>>
      )[tab.value]
)

const tabProps = computed(() => (tab.value === 'categories' || tab.value === 'tags' ? { section: tab.value } : {}))
</script>

<template>
  <div class="settings">
    <header class="head">
      <button class="btn btn--subtle" @click="router.push(returnTarget)">
        <ArrowLeft :size="16" />{{ $t("返回") }}</button>
      <h1>
        {{ globalScope ? $t('全局设置') : $t('模块设置') }}
        <span v-if="!globalScope" class="head__module">
          {{ MODULE_LABELS[activeModule] }}
        </span>
      </h1>
      <nav class="scope-nav" :aria-label="$t('设置模块')">
        <button :class="{ on: globalScope }" @click="switchScope('global')">{{ $t("全局") }}</button>
        <button
          v-for="module in MODULE_TABS"
          :key="module.key"
          :class="{ on: !globalScope && activeModule === module.key }"
          @click="switchScope(module.key)"
        >
          {{ module.label }}
        </button>
      </nav>
    </header>

    <div class="layout">
      <nav class="nav no-select">
        <div class="nav__group-title">{{ $t("{p0}设置", {p0: (MODULE_LABELS[activeModule])}) }}</div>
        <template v-for="t in moduleTabs" :key="t.id">
          <div v-if="t.id === 'hentai'" class="nav__divider"><span>{{ $t("里番区") }}</span></div>
          <button class="nav__item" :class="{ on: tab === t.id }" @click="go(t.id)">
            <component :is="t.icon" :size="15" />
            {{ t.label }}
          </button>
        </template>

        <div class="nav__group-title nav__group-title--spaced">{{ $t("通用设置") }}</div>
        <button v-for="t in globalTabs" :key="t.id" class="nav__item" :class="{ on: tab === t.id }" @click="go(t.id)">
          <component :is="t.icon" :size="15" />
          {{ t.label }}
        </button>
      </nav>

      <div class="body">
        <ImageSettings v-if="!globalScope && activeModule === 'image'" :section="tab" />
        <DocumentSettings v-else-if="!globalScope && activeModule === 'document'" :section="tab" />
        <template v-else-if="tab === 'project'"><ModulePreferences module="project" /><ProjectSettings /></template>
        <PersonalSettings v-else-if="tab === 'personal'" />
        <VideoTaxonomySettings
          v-else-if="tab === 'hentai-groups' || tab === 'hentai-tags'"
          :key="tab"
          :section="tab === 'hentai-groups' ? 'groups' : 'tags'"
          :hentai="true"
        />
        <KeepAlive><component v-if="tabComponent" :is="tabComponent" :key="tab === 'tags' ? 'categories' : tab" v-bind="tabProps" /></KeepAlive>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scope-nav { display:flex; gap:4px; flex-wrap:wrap; margin-left:auto; }

.scope-nav button { padding:7px 12px; border-radius:var(--radius-btn); color:var(--text-sub); }

.scope-nav button:hover, .scope-nav .on { background:var(--active-surface); color:var(--accent); }

.nav__group-title {
  padding: 2px 12px 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}

.nav__group-title--spaced {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--divider);
}

.nav__divider { border-top:1px solid var(--divider); margin:14px 0 6px; padding:12px 12px 2px; font-size:12px; color:var(--text-faint); }

.settings {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 14px 24px;
  background: var(--bg-main);
  border-bottom: 1px solid var(--divider);
}

.head h1 {
  font-size: var(--fs-title);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
}

.head__module {
  font-size: var(--fs-body);
  font-weight: 400;
  color: var(--text-sub);
  padding: 2px 8px;
  border-radius: var(--radius-tag);
  background: var(--hover-surface);
}

.layout {
  flex: 1;
  min-height: 0;
  display: flex;
}

.nav {
  flex: none;
  width: 184px;
  padding: 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--divider);
  overflow-y: auto;
}

.nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 12px;
  border-radius: var(--radius-btn);
  font-size: var(--fs-body);
  color: var(--text-sub);
  text-align: left;
  transition:
    background var(--t-fast) ease,
    color var(--t-fast) ease;
}

.nav__item:hover {
  background: var(--hover-surface);
  color: var(--text-main);
}

.nav__item.on {
  background: var(--active-surface);
  color: var(--accent);
}

.body {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.body > :deep(*) {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
}
</style>
