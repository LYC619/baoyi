<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

import { confirmDialog } from '@/composables/useDialog'
import { errorMessage } from '@/utils'
import { ref, computed, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  UserRound,
  Plus,
  Pencil,
  ArrowUpRight,
  Backpack,
  Activity,
  Award,
  Sprout,
  CheckSquare,
} from "lucide-vue-next";
import PersonalEditor from "@/components/personal/PersonalEditor.vue";
import StateHistory from "@/components/personal/StateHistory.vue";
import ResourceLinks from "@/components/workspace/ResourceLinks.vue";
import PersonalAssistant from "@/components/personal/PersonalAssistant.vue";
import ExperienceTimeline from "@/components/personal/ExperienceTimeline.vue";
import StateCapture from "@/components/personal/StateCapture.vue";
import SkillCards from "@/components/personal/SkillCards.vue";
import AssetGrid from "@/components/personal/AssetGrid.vue";
import AssetReminderDialog from "@/components/personal/AssetReminderDialog.vue";
import { isReminding, isSnoozed } from '@/utils/personal-assets';
import { useToast } from '@/composables/useToast';
import { workspace, plain, kindLabels } from "@/utils/workspace-api";
import { usePersonalDate, usePersonalView } from "@/composables/usePersonalView";
import { dueText, filterTodos } from "@/utils/personal-view";
import type { SkillCard } from "@/types/skill-profile";
import { DEFAULT_MODULE_PREFERENCES } from "@/types/workspace";
import type { PersonalRecord, PersonalKind } from "@/types/workspace";
import type { ProjectItem } from "@/types/project";
import "@/styles/workspace.css";
async function openAssetUrl(raw: string) {
  try { const input=raw.trim(); const url=new URL(/^[a-z][a-z0-9+.-]*:/i.test(input)?input:'https://'+input); if(!['http:','https:'].includes(url.protocol))throw new Error(tr('管理入口仅支持 HTTP 或 HTTPS 链接')); await window.baoyi.app.openUrl(url.href) }
  catch(cause){error.value=errorMessage(cause)}
}
const quickTodo = ref(""), quickDue = ref("");
const view = usePersonalView('home', {todoView:'',todoPreference:'',todoQuery:'',stateQuery:''});
const assetView = usePersonalView('assets', {query:'',category:'',sort:'expiry',status:'all'});
const skillCardsRef = ref<InstanceType<typeof SkillCards>>();
const today = usePersonalDate();
const todoView = computed({get:() => view.todoView || (preferences.value.showCompleted ? 'all' : 'active'),set:(value:string) => {view.todoView=value}});
const filteredTodos = computed(() => filterTodos(records.value, todoView.value, view.todoQuery, today.value));
const pendingTodos = computed(() => filterTodos(records.value, 'active', '', today.value));
const overdueTodos = computed(() => filterTodos(records.value, 'overdue', '', today.value));
const metrics = computed(() => list('metric').filter(r => [r.name,r.data.unit].join(' ').toLocaleLowerCase().includes(view.stateQuery.trim().toLocaleLowerCase())));
const skillCards = ref<SkillCard[]>([]);
const recentSkills = computed(() => [...skillCards.value].sort((a,b) => (b.records.at(-1)?.date || '').localeCompare(a.records.at(-1)?.date || '')).slice(0,6));
const activeProjects = computed(() => projects.value.filter(x=>['active','maintaining'].includes(x.state)));
async function captureTodo() {
  if (!quickTodo.value.trim() || busy.value) return;
  await action(async () => {
    await workspace.personal.save({
      kind: "todo",
      name: quickTodo.value.trim(),
      body: "",
      data: { done: false, dueOn: quickDue.value },
    });
    quickTodo.value = "";
    quickDue.value = "";
  });
}
const assistant = ref<InstanceType<typeof PersonalAssistant>>();
const router = useRouter(),
  route = useRoute(),
  records = ref<PersonalRecord[]>([]),
  counts = ref<Record<string, number>>({}),
  projects = ref<ProjectItem[]>([]),
  nextSteps = ref<Array<{ id: string; name: string; next: string }>>([]),
  error = ref(""),
  warning = ref(""),
  loading = ref(false),
  busy = ref(false),
  editing = ref(false),
  editKind = ref<PersonalKind>("profile"),
  editRecord = ref<PersonalRecord>(),
  metricId = ref("");
const tabs = [
  { id: "overview", get label() { return tr("总览") }, icon: UserRound },
  { id: "skill", get label() { return tr("技能") }, icon: Sprout },
  { id: "asset", get label() { return tr("背包") }, icon: Backpack },
  { id: "state", get label() { return tr("状态") }, icon: Activity },
  { id: "experience", get label() { return tr("奖项与经历") }, icon: Award },
  { id: "todo", get label() { return tr("待办") }, icon: CheckSquare },
];
const section = computed(() =>
    tabs.some((t) => t.id === route.query.section)
      ? String(route.query.section)
      : "overview",
  ),
  title = computed(() => tabs.find((t) => t.id === section.value)!.label),
  profile = computed(() => records.value.find((r) => r.kind === "profile"));
const preferences = ref(structuredClone(DEFAULT_MODULE_PREFERENCES));
const list = (kind: string) =>
  records.value.filter(
    (r) =>
      r.kind === kind &&
      (kind !== "todo" || preferences.value.showCompleted || !r.data.done),
  );
const selected = computed(() =>
  records.value.find(
    (r) => r.id === route.query.record && r.kind === section.value,
  ),
);
const activeMetric = computed(
  () =>
    list("metric").find((r) => r.id === metricId.value) || list("metric")[0],
);
const dueAssets = computed(() => list('asset').filter(r => isReminding(r, preferences.value.remindDays, today.value)).sort((a,b)=>String(a.data.expiresOn).localeCompare(String(b.data.expiresOn))));
const assetDialog = ref<'renew' | 'snooze' | null>(null);
const dueLabel = (r: PersonalRecord) => dueText(r.data.expiresOn,today.value);
let revision = 0;
async function load() {
  const run = ++revision;
  loading.value = true;
  const result = await Promise.allSettled([workspace.preferences.get('personal'), workspace.personal.list(), workspace.personal.overview(), window.baoyi.project.list(), workspace.skills.list()] as const);
  if(run !== revision) return;
  error.value=''; warning.value='';
  const [prefs,personal,overview,project,skills] = result;
  if(personal.status === 'fulfilled') records.value=personal.value;
  else error.value=tr("个人记录读取失败：") + errorMessage(personal.reason);
  if(prefs.status === 'fulfilled') {
    const nextPreference=String(prefs.value.showCompleted);
    // A changed default updates general views, while explicit date/completed filters stay selected.
    if(view.todoPreference!==nextPreference && ['active','all'].includes(view.todoView)) view.todoView='';
    view.todoPreference=nextPreference;
    preferences.value=prefs.value;
  }
  if(overview.status === 'fulfilled') counts.value=overview.value.counts;
  if(skills.status === 'fulfilled') skillCards.value=skills.value;
  if(project.status === 'fulfilled') projects.value=project.value;
  if(result.some((r,i)=>i !== 1 && r.status === 'rejected')) warning.value=tr("部分概览暂未载入，已有个人记录仍可使用。");
  const next = project.status === 'fulfilled' ? await Promise.allSettled(project.value.filter(x=>x.state !== 'archived').map(async x => ({id:x.id,name:x.name,...await workspace.timeline.context(x.id)}))) : [];
  if(run !== revision) return;
  if(project.status === 'fulfilled') nextSteps.value=next.flatMap(r=>r.status==='fulfilled' && r.value.next ? [r.value] : []);
  if(next.some(r=>r.status==='rejected')) warning.value=tr("部分项目的下一步读取失败，个人记录已载入。");
  loading.value=false;
}
void load();
const unsubscribe = workspace.onChanged(() => void load()),
  unsubscribeProject = window.baoyi.project.onChanged(() => void load());
onBeforeUnmount(() => {
  revision++;
  unsubscribe();
  unsubscribeProject();
});
function go(id: string, record?: string) {
  void router.push({
    path: "/personal",
    query: { section: id, ...(record ? { record } : {}) },
  });
}
function edit(kind: PersonalKind, record?: PersonalRecord) {
  editKind.value = kind;
  editRecord.value = record;
  editing.value = true;
}
async function action(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = errorMessage(e);
    useToast().error(error.value);
  } finally {
    busy.value = false;
  }
}
async function remove(record: PersonalRecord) {
  if (!(await confirmDialog({ title: tr('删除个人记录「{p0}」？', {p0: record.name}), message: tr("仅删除这条个人记录，已关联的外部资料与本地文件均会保留。"), confirmText: tr('删除记录'), tone: 'danger' }))) return;
  await action(async () => {
    await workspace.personal.remove(record.id);
    if (selected.value?.id === record.id) go(section.value);
  });
}
async function toggle(record: PersonalRecord) {
  await action(() =>
    workspace.personal.save(
      plain({
        id: record.id,
        kind: record.kind,
        name: record.name,
        body: record.body,
        data: { ...record.data, done: !record.data.done },
      }),
    ),
  );
}
function saved(record: PersonalRecord) {
  void load();
  if (["skill", "asset", "experience"].includes(record.kind))
    go(record.kind, record.id);
  if (record.kind === "metric") metricId.value = record.id;
}
</script>
<template>
  <main class="ws ws-layout personal-home">
    <aside class="ws-sidebar">
      <h2>{{ $t("我") }}</h2>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="{ active: section === tab.id }"
        @click="go(tab.id)"
      >
        <component :is="tab.icon" :size="16" />{{ tab.label }}</button
      ><PersonalAssistant ref="assistant" /><small>{{ $t("知止而后得") }}</small>
    </aside>
    <section class="ws-main">
      <header class="ws-header">
        <div>
          <h1>{{ title }}</h1>
          <p class="ws-muted">
            {{
              section === "overview"
                ? $t('我拥有的、做过的，以及正在成为的。')
                : section === "skill"
                  ? $t('从具体实践回看自己。')
                  : section === "asset"
                    ? $t('记住用途、费用与到期时间。')
                    : section === "state"
                      ? $t('只和自己的昨天相比。')
                      : section === "experience"
                        ? $t('留下值得回看的时刻。')
                        : $t('下一步，从一件小事开始。')
            }}
          </p>
        </div>
        <button
          v-if="['asset', 'experience', 'todo'].includes(section)"
          class="ws-button primary"
          @click="edit(section as PersonalKind)"
        >
          <Plus :size="16" />{{ $t("添加{p0}", {p0: (title)}) }}</button
        ><button
          v-if="section === 'skill'"
          class="ws-button primary"
          @click="skillCardsRef?.openCreate()"
        >
          <Plus :size="16" />{{ $t("新建技能卡片") }}</button
        ><button v-if="section === 'skill'" class="ws-button" @click="assistant?.open($t('帮我建立技能卡片，先查已有记录。'))">{{ $t("让助理帮建") }}</button
        >
      </header>
      <p v-if="loading" class="ws-muted" role="status">{{ $t("正在更新个人记录…") }}</p>
      <div v-if="error || warning" class="ws-toolbar"><p :class="error ? 'ws-error' : 'ws-muted'" role="alert">{{ error || warning }}</p><button class="ws-button" :disabled="loading" @click="load">{{ $t("重新加载") }}</button></div>
      <template v-if="section === 'overview'"
        ><section class="personal-identity">
          <span class="personal-avatar"
            ><img
              v-if="profile?.data.avatar"
              :src="String(profile.data.avatar)"
              :alt="$t('个人头像')"
              style="
                width: 100%;
                height: 100%;
                object-fit: cover;
                border-radius: 9px;
              " /><UserRound v-else :size="33"
          /></span>
          <div>
            <h2>{{ profile?.name || $t('从认识自己开始') }}</h2>
            <p>
              {{
                profile?.data.motto || $t('实践、资源与经历，都在这里慢慢积累。')
              }}
            </p>
          </div>
          <button
            class="ws-icon"
            :aria-label="$t('编辑个人信息')"
            @click="edit('profile', profile)"
          >
            <Pencil :size="17" />
          </button>
        </section>
        <div class="ws-toolbar">
          <button
            class="ws-button"
            @click="edit('asset')"
          >{{ $t("记一项资产") }}</button
          ><button class="ws-button" @click="go('state')">{{ $t("记录状态") }}</button
          ><button class="ws-button" @click="go('todo')">{{ $t("记一件待办") }}</button>
        </div>
        <div class="personal-focus" :aria-label="$t('近期要处理')">
          <button @click="view.todoView='active';go('todo')"><span>{{ $t("未完成待办") }}</span><strong>{{ pendingTodos.length }}</strong><small>{{ overdueTodos.length ? overdueTodos.length + $t(' 项已逾期') : $t('按自己的节奏推进') }}</small></button>
          <button @click="assetView.status=dueAssets.length?'reminding':'all';go('asset')"><span>{{ $t("到期事项") }}</span><strong>{{ dueAssets.length }}</strong><small>{{ $t("已到期及 {p0} 天内", {p0: (preferences.remindDays)}) }}</small></button>
          <button @click="router.push('/project')"><span>{{ $t("进行中的项目") }}</span><strong>{{ activeProjects.length }}</strong><small>{{ $t("实践与维护中的工作") }}</small></button>
        </div>
        <div class="personal-overview">
          <div>
            <section class="personal-block">
              <header class="ws-section-head">
                <h2>{{ $t("最近的实践") }}</h2>
                <button class="ws-button" @click="go('skill')">{{ $t("所有技能") }}</button>
              </header>
              <div class="personal-cards">
                <button
                  v-for="skill in recentSkills"
                  :key="skill.id"
                  class="personal-card"
                  @click="go('skill', skill.id)"
                >
                  <h3>{{ skill.name }}</h3>
                  <p class="ws-muted">
                    {{ skill.records.at(-1)?.date || $t('实践与自评') }}
                  </p>
                  <p class="ws-pre">
                    {{
                      skill.summary.slice(0, 110) || $t('尚未补充事实摘要')
                    }}
                  </p>
                </button>
              </div>
              <p v-if="!recentSkills.length" class="ws-muted">{{ $t("从一次实践开始，记录你用过什么、做出了什么。") }}</p>
            </section>
            <section class="personal-block">
              <header class="ws-section-head">
                <h2>{{ $t("正在做的事") }}</h2>
                <button class="ws-button" @click="router.push('/project')">{{ $t("全部项目") }}</button>
              </header>
              <button
                v-for="p in activeProjects.slice(0, 6)"
                :key="p.id"
                class="personal-project"
                @click="router.push({ path: '/project/' + p.id, query: { from: route.fullPath } })"
              >
                <span
                  ><strong>{{ p.name }}</strong
                  ><small>{{
                    nextSteps.find((x) => x.id === p.id)?.next || p.summary
                  }}</small></span
                ><ArrowUpRight :size="16" />
              </button>
              <p v-if="!activeProjects.length" class="ws-muted">{{ $t("登记一个项目，把资料与实践连起来。") }}</p>
            </section>
          </div>
          <aside>
            <section v-if="pendingTodos.length" class="personal-block"><header class="ws-section-head"><h2>{{ $t("下一件小事") }}</h2><button class="ws-button" @click="go('todo')">{{ $t("全部待办") }}</button></header><div v-for="todo in pendingTodos.slice(0,3)" :key="todo.id" class="personal-due-todo"><input type="checkbox" :checked="!!todo.data.done" :disabled="busy" :aria-label="$t('完成 ') + todo.name" @change="toggle(todo)" /><button class="personal-due" @click="edit('todo',todo)"><strong>{{ todo.name }}</strong><small>{{ dueText(todo.data.dueOn,today) }}</small></button></div></section>
            <section v-if="preferences.showCounts" class="personal-block">
              <header class="ws-section-head">
                <h2>{{ $t("我的资源") }}</h2>
                <Backpack :size="19" />
              </header>
              <button
                v-for="(count, kind) in preferences.showCounts ? counts : {}"
                :key="kind"
                class="personal-count"
                @click="router.push(kind === 'software' ? '/' : '/' + kind)"
              >
                <span>{{ kindLabels[kind] }}</span
                ><strong>{{ count }}</strong>
              </button>
            </section>
            <section class="personal-block">
              <header class="ws-section-head">
                <h2>{{ $t("近期到期") }}</h2>
                <button
                  class="ws-icon"
                  :aria-label="$t('查看背包')"
                  @click="go('asset')"
                >
                  <ArrowUpRight :size="17" />
                </button>
              </header>
              <button
                v-for="a in dueAssets.slice(0, 5)"
                :key="a.id"
                class="personal-due"
                @click="go('asset', a.id)"
              >
                <strong>{{ a.name }}</strong
                ><span>{{ a.data.expiresOn }}</span
                ><small
                  :class="{ overdue: String(a.data.expiresOn) <= today }"
                  >{{ dueLabel(a) }}</small
                >
              </button>
              <p v-if="!dueAssets.length" class="ws-muted">{{ $t("暂无已到期或提醒范围内的资产。") }}</p>
            </section>
          </aside>
        </div></template
      >
      <template v-else-if="section === 'state'">
        <StateCapture :metrics="list('metric')" />
        <div class="ws-toolbar"><input v-model="view.stateQuery" :aria-label="$t('搜索状态指标')" :placeholder="$t('搜索指标或单位')" /><small class="ws-muted">{{ $t("{p0} / {p1} 项指标", {p0: (metrics.length), p1: (list('metric').length)}) }}</small></div>
        <p v-if="!metrics.length" class="ws-empty">{{ list('metric').length ? $t('没有符合条件的指标。') : $t('在上方填写指标名称、单位和数值，开始第一条记录。') }}</p>
        <div class="personal-state-grid">
          <section
            v-for="metric in metrics"
            :key="metric.id"
            class="ws-panel"
          >
            <div class="ws-toolbar">
              <button class="ws-button" @click="edit('metric', metric)">{{ $t("编辑指标") }}</button
              ><button
                class="ws-button danger"
                :disabled="busy"
                @click="remove(metric)"
              >{{ $t("移除指标") }}</button>
            </div>
            <StateHistory
              :metric="metric"
              :records="list('measurement')"
              @edit="edit('measurement', $event)"
              @remove="remove"
            />
          </section>
        </div>
      </template>
      <template v-else-if="section === 'todo'"
        ><div class="personal-todos">
          <div class="ws-toolbar">
            <input v-model="view.todoQuery" :aria-label="$t('搜索待办')" :placeholder="$t('搜索待办名称或备注')" />
            <select v-model="todoView" :aria-label="$t('待办视图')">
              <option value="active">{{ $t("未完成") }}</option>
              <option value="overdue">{{ $t("已逾期") }}</option>
              <option value="today">{{ $t("今日") }}</option>
              <option value="upcoming">{{ $t("未来七天") }}</option>
              <option value="completed">{{ $t("已完成") }}</option>
              <option value="all">{{ $t("全部") }}</option>
            </select>
          </div>
          <form class="ws-toolbar" @submit.prevent="captureTodo">
            <input
              v-model="quickTodo"
              :aria-label="$t('快速添加待办')"
              :placeholder="$t('记下一件小事，按 Enter 添加')"
              maxlength="300"
            /><input v-model="quickDue" :aria-label="$t('快速待办日期')" type="date" /><button
              class="ws-button primary"
              :disabled="busy || !quickTodo.trim()"
            >{{ $t("添加") }}</button>
          </form>
          <p class="ws-muted" role="status">{{ $t("当前视图 {p0} 项 · 按截止日排序", {p0: (filteredTodos.length)}) }}</p>
          <p v-if="!filteredTodos.length" class="ws-empty">{{ $t("当前视图没有待办，可以调整筛选或在上方添加。") }}</p>
          <article v-for="todo in filteredTodos" :key="todo.id">
            <input
              type="checkbox"
              :checked="!!todo.data.done"
              :disabled="busy"
              :aria-label="$t('完成 ') + todo.name"
              @change="toggle(todo)"
            />
            <div>
              <strong :class="{ done: todo.data.done }">{{ todo.name }}</strong>
              <p class="ws-muted">
                {{ todo.data.dueOn || $t('未设置日期') }}<span v-if="!todo.data.done && todo.data.dueOn"> · {{ dueText(todo.data.dueOn,today) }}</span>
              </p>
              <p v-if="todo.body" class="ws-pre">{{ todo.body }}</p>
            </div>
            <button
              class="ws-icon"
              :aria-label="$t('编辑待办')"
              @click="edit('todo', todo)"
            >
              <Pencil :size="15" /></button
            ><button
              class="ws-icon"
              :aria-label="$t('删除待办')"
              @click="remove(todo)"
            >
              ×
            </button>
          </article>
</div
      ></template>
      <template v-else-if="section === 'skill'"
        ><SkillCards
          ref="skillCardsRef"
          @compose="assistant?.open($event)"
          @edit="
            edit(
              'skill',
              records.find((r) => r.id === $event),
            )
          "
          @remove="
            records.find((r) => r.id === $event) &&
            remove(records.find((r) => r.id === $event)!)
          " /></template
      ><template v-else-if="section === 'experience'"
        ><ExperienceTimeline
          :records="list('experience')"
          @edit="edit('experience', $event)"
          @remove="remove" /></template
      ><template v-else-if="section === 'asset'"
        ><AssetGrid
          v-if="!selected"
          :records="list('asset')"
          :categories="preferences.assetCategories"
          :today="today"
          :remind-days="preferences.remindDays"
          @select="go('asset', $event.id)"
        />
        <article v-if="selected" class="ws-panel asset-detail">
          <button class="ws-button" @click="go('asset')">{{ $t("返回背包列表") }}</button>
          <header class="ws-section-head">
            <h2>{{ selected.name }}</h2>
            <button class="ws-button" @click="edit('asset', selected)">{{ $t("编辑") }}</button>
          </header>
          <dl class="asset-facts"><div><dt>{{ $t("类别 / 提供方") }}</dt><dd>{{ selected.data.category || $t('其他') }} · {{ selected.data.provider || $t('未填写') }}</dd></div><div><dt>{{ $t("费用 / 周期") }}</dt><dd>{{ typeof selected.data.cost === 'number' ? selected.data.cost + ' ' + (selected.data.currency || '') : $t('费用未填写') }} · {{ ({monthly:$t('每月'),yearly:$t('每年'),once:$t('一次性'),other:$t('其他周期')} as Record<string,string>)[String(selected.data.cycle)] || $t('未设置周期') }}</dd></div><div><dt>{{ $t("到期") }}</dt><dd>{{ selected.data.expiresOn || $t('未设到期日') }} <small>{{ selected.data.expiresOn ? dueLabel(selected) : '' }}</small></dd></div></dl>
          <div class="asset-reminder-actions"><button class="ws-button" :disabled="busy" @click="assetDialog = 'renew'">{{ $t("已续费") }}</button><button v-if="isSnoozed(selected, today)" class="ws-button" :disabled="busy" @click="action(() => workspace.personal.snooze(selected!.id, null))">{{ $t("取消暂缓") }}</button><button v-else class="ws-button" :disabled="busy" @click="assetDialog = 'snooze'">{{ $t("暂缓提醒") }}</button><small v-if="isSnoozed(selected, today)" class="ws-muted">{{ $t("已暂缓至 {p0}", {p0: (selected.data.snoozedUntil)}) }}</small></div>
          <section v-if="selected.data.renewals?.length" class="asset-renewals"><h3>{{ $t("续费记录") }}</h3><ul><li v-for="(renewal, index) in [...selected.data.renewals].reverse()" :key="index"><time>{{ renewal.on }}</time><span>{{ renewal.from || $t('未设到期日') }} → {{ renewal.to }}</span><span>{{ renewal.cost === undefined ? $t('费用未填写') : renewal.cost + ' ' + (renewal.currency || '') }}</span></li></ul></section>
          <p class="ws-pre">{{ selected.body || $t('尚未补充用途或备注') }}</p>
          <button v-if="selected.data.url" class="ws-button" @click="openAssetUrl(String(selected.data.url))">{{ $t("管理入口") }}</button><ResourceLinks
            owner="asset"
            :id="selected.id"
            :key="selected.id"
            :title="$t('相关资料')"
          /><button
            class="ws-button danger"
            :disabled="busy"
            @click="remove(selected)"
          >{{ $t("删除这条记录") }}</button>
        </article></template
      >
      <PersonalEditor
        v-if="editing"
        :kind="editKind"
        :record="editRecord"
        :metrics="list('metric')"
        :metric-id="activeMetric?.id"
        @close="editing = false"
        @saved="saved"
      />
      <AssetReminderDialog v-if="assetDialog && selected?.kind === 'asset'" :key="selected.id + ':' + assetDialog" :record="selected" :mode="assetDialog" :today="today" @close="assetDialog = null" @saved="saved" />
    </section>

  </main>
</template>
<style scoped>
.personal-focus { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin:0 0 28px; }
.personal-due-todo { display:flex; align-items:center; gap:10px; border-bottom:1px solid var(--divider); }
.personal-due-todo .personal-due { border-bottom:0; flex:1; min-width:0; }
.personal-due-todo input { width:16px; height:16px; accent-color:var(--accent); flex:none; }
.personal-focus button { display:flex; flex-direction:column; align-items:flex-start; gap:8px; padding:18px; border:1px solid var(--card-border,var(--divider)); border-radius:var(--radius-card); color:var(--text-main); background:var(--bg-card); box-shadow:var(--shadow-card); text-align:left; transition:border-color var(--t-fast) ease,background var(--t-fast) ease; }
.personal-focus button:hover { border-color:var(--accent); background:var(--bg-card-hover); }
.personal-focus strong { font-size:28px; color:var(--accent-ink,var(--accent)); font-weight:600; }
.personal-focus small { color:var(--text-sub); }
.asset-detail > .ws-section-head { margin-top:20px; }
.asset-reminder-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin:18px 0; }
.asset-renewals { margin:24px 0; }.asset-renewals h3 { font-size:14px; }.asset-renewals ul { padding:0; list-style:none; }.asset-renewals li { display:flex; flex-wrap:wrap; gap:10px 24px; padding:10px 0; border-bottom:1px solid var(--divider); font-size:12px; }.asset-renewals time { color:var(--text-sub); }
.asset-facts { display:flex; flex-wrap:wrap; gap:24px; padding:18px 0; border-block:1px solid var(--divider); }
.asset-facts dt { font-size:12px; color:var(--text-sub); margin-bottom:8px; }
.asset-facts dd { margin:0; overflow-wrap:anywhere; }
.personal-todos strong,.personal-due strong { overflow-wrap:anywhere; }
@media(max-width:900px) { .personal-focus {gap:8px;} .personal-focus button{padding:12px;} }

.personal-state-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
  gap: 20px;
}
.personal-home {
  position: relative;
}
.personal-home .ws-main {
  padding-bottom: 88px;
}
.personal-identity {
  display: flex;
  gap: 22px;
  align-items: center;
  border-bottom: 1px solid var(--divider);
  padding: 0 0 28px;
  margin-bottom: 28px;
}
.personal-identity > div {
  flex: 1;
}
.personal-identity h2 {
  font-size: 23px;
  margin: 0 0 5px;
}
.personal-identity p {
  color: var(--text-sub);
  font-size: 13px;
}
.personal-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border: 1px solid var(--divider);
  border-radius: 9px;
  color: var(--accent);
  background: var(--ws-tint);
}
.personal-overview {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(230px, 1fr);
  gap: 32px;
}
.personal-overview > aside {
  border-left: 1px solid var(--divider);
  padding-left: 28px;
}
.personal-block {
  margin-bottom: 30px;
}
.personal-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.personal-card {
  padding: 19px;
  text-align: left;
  border: 1px solid var(--divider);
  border-radius: 6px;
  min-height: 130px;
  color: var(--text-main);
}
.personal-card:hover {
  border-color: var(--accent);
}
.personal-card h3 {
  font-weight: 500;
}
.personal-card > p:last-child {
  font-size: 12px;
  color: var(--text-sub);
}
.personal-count {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  border-bottom: 1px solid var(--divider);
  padding: 12px 0;
  color: var(--text-main);
}
.personal-count strong {
  font-weight: 400;
  color: var(--text-sub);
}
.personal-due {
  display: flex;
  flex-direction: column;
  text-align: left;
  width: 100%;
  padding: 14px 0;
  border-bottom: 1px solid var(--divider);
  gap: 4px;
  color: var(--text-main);
}
.personal-due strong {
  font-size: 13px;
  font-weight: 500;
}
.personal-due span,
.personal-due small {
  font-size: 12px;
  color: var(--text-sub);
}
.personal-due .overdue {
  color: var(--warning);
}
.personal-project {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 13px 0;
  text-align: left;
  border-bottom: 1px solid var(--divider);
  gap: 15px;
  color: var(--text-main);
}
.personal-project strong {
  font-size: 13px;
  font-weight: 500;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.personal-project small {
  display: block;
  font-size: 12px;
  margin-top: 5px;
  color: var(--text-sub);
}
.personal-record-layout {
  display: flex;
  gap: 26px;
}
.personal-record-list {
  flex: 1;
  min-width: 0;
  max-width: 430px;
}
.personal-record {
  display: block;
  width: 100%;
  text-align: left;
  border-bottom: 1px solid var(--divider);
  padding: 18px 15px;
  color: var(--text-main);
}
.personal-record.active {
  background: var(--ws-tint);
  border-left: 2px solid var(--accent);
}
.personal-record p,
.personal-record small {
  font-size: 12px;
  color: var(--text-sub);
  overflow-wrap: anywhere;
}
.personal-record h3 {
  overflow-wrap: anywhere;
}
.personal-record-detail {
  flex: 1.5;
  min-width: 0;
  padding: 10px 0 20px 26px;
  border-left: 1px solid var(--divider);
}
.personal-record-detail h2 {
  font-size: 23px;
  overflow-wrap: anywhere;
}
.personal-record-detail p {
  font-size: 14px;
}
.personal-remove {
  margin-top: 24px;
}
.personal-todos {
  max-width: 900px;
}
.personal-todos > article {
  display: flex;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--divider);
  padding: 15px 0;
}
.personal-todos > article > div {
  flex: 1;
}
.personal-todos strong {
  font-size: 14px;
  font-weight: 500;
}
.personal-todos .done {
  text-decoration: line-through;
  color: var(--text-sub);
}
.personal-todos h2 {
  margin-top: 30px;
}
@media (max-width: 1050px) {
  .personal-overview {
    gap: 20px;
  }
  .personal-overview > aside {
    padding-left: 20px;
  }
  .personal-record-layout {
    gap: 16px;
  }
  .personal-record-detail {
    padding-left: 16px;
  }
  .personal-record-list {
    max-width: 310px;
  }
}
@media (max-width: 800px) {
  .personal-overview {
    grid-template-columns: 1fr;
  }
  .personal-overview > aside {
    padding-left: 0;
    border-left: 0;
  }
  .personal-record-layout {
    flex-direction: column;
  }
  .personal-record-list {
    max-width: none;
  }
  .personal-record-detail {
    border-left: 0;
    padding: 20px 0;
  }
  .personal-cards {
    grid-template-columns: 1fr;
  }
}
</style>
