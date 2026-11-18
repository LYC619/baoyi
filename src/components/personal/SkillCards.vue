<script setup lang="ts">
import { errorMessage } from '@/utils'
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { workspace, plain } from "@/utils/workspace-api";
import type { SkillCard, SkillProposal } from "@/types/skill-profile";
import { useRoute, useRouter } from "vue-router";
import { usePersonalView } from "@/composables/usePersonalView";
import SkillTree from "./SkillTree.vue";
import MetricTrend from "./MetricTrend.vue";
import ResourceLinks from "@/components/workspace/ResourceLinks.vue";
const emit = defineEmits<{
  compose: [text: string];
  edit: [id: string];
  remove: [id: string];
}>();
const route = useRoute(), router = useRouter();
const selected = computed({ get: () => typeof route.query.record === 'string' ? route.query.record : '', set: value => { const query={...route.query}; if(value) query.record=value; else delete query.record; void router.replace({path:route.path,query}) } });
const view = usePersonalView('skills', {query:''});
const detail = ref<HTMLElement>();
watch(selected, async value => { if(value) { await nextTick(); detail.value?.focus() } });
const cards = ref<SkillCard[]>([]),
  proposals = ref<SkillProposal[]>([]),
  error = ref(""),
  busy = ref(false);
let revision = 0;
async function load() {
  const run = ++revision;
  try {
    const [c, p] = await Promise.all([
      workspace.skills.list(),
      workspace.skills.proposals(),
    ]);
    if (run === revision) {
      cards.value = c;
      proposals.value = p;
      error.value = "";
    }
  } catch (e) {
    if (run === revision) error.value = errorMessage(e);
  }
}
void load();
const off = workspace.onChanged(() => void load());
onBeforeUnmount(() => {
  revision++;
  off();
});
async function act(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
const filtered = computed(() => cards.value.filter(c => [c.name,c.summary,...c.metrics.map(m=>m.label)].join(' ').toLocaleLowerCase().includes(view.query.trim().toLocaleLowerCase())));
const currentCard = computed(() => cards.value.find(c=>c.id === selected.value));
const latest = (card: SkillCard, key: string, version: number) =>
  card.records
    .filter((r) => r.metricKey === key && r.version === version)
    .at(-1);
const currentMetrics = (card: SkillCard) =>
  card.metrics.filter(
    (m) =>
      !card.metrics.some(
        (other) => other.key === m.key && other.version > m.version,
      ),
  );
</script>
<template>
  <section class="skill-browser">
    <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
    <article
      v-for="proposal in proposals"
      :key="proposal.id"
      class="ws-panel skill-draft"
    >
      <header class="ws-section-head">
        <h2>技能草案 · 待确认</h2>
        <span class="ws-badge">确认前不会录入</span>
      </header>
      <label
        >技能名称<input v-model="proposal.draft.name" maxlength="300"
      /></label>
      <label
        >事实摘要<textarea v-model="proposal.draft.summary" maxlength="10000" />
      </label>
      <div
        v-for="metric in proposal.draft.metrics"
        :key="metric.key"
        class="metric-edit"
      >
        <label>指标<input v-model="metric.label" maxlength="300" /></label
        ><label>单位<input v-model="metric.unit" maxlength="50" /></label>
        <label
          >类型<select v-model="metric.type">
            <option value="number">数值</option>
            <option value="text">文本</option>
            <option value="date">日期</option>
          </select></label
        >
      </div>
      <p class="ws-muted">
        新口径另存版本，历史记录保留原单位和定义，不混合绘图。
      </p>
      <div class="ws-toolbar">
        <button
          class="ws-button primary"
          :disabled="busy"
          @click="
            act(() =>
              workspace.skills.confirm(proposal.id, plain(proposal.draft)),
            )
          "
        >
          确认录入</button
        ><button
          class="ws-button"
          :disabled="busy"
          @click="act(() => workspace.skills.cancel(proposal.id))"
        >
          取消草案
        </button>
      </div>
    </article>
    <div v-if="!cards.length && !proposals.length" class="ws-empty">
      <h2>从一项具体实践开始</h2>
      <p>告诉助手你的成绩、作品或经历，核对草案后建立技能卡片。</p>
      <button
        class="ws-button primary"
        @click="
          emit('compose', '帮我建立一张技能卡片，先查已有技能和相关资源。')
        "
      >
        开始技能建档
      </button>
    </div>
    <details v-if="cards.some((c) => c.parentId)" class="skill-hierarchy">
      <summary>技能层级</summary>
      <SkillTree :cards="cards" @select="selected = $event" />
    </details>
    <div class="ws-toolbar"><input v-model="view.query" aria-label="搜索技能" placeholder="搜索技能、实践摘要或指标" /><small class="ws-muted" role="status">{{ filtered.length }} / {{ cards.length }} 项技能</small><button v-if="view.query" class="ws-button" @click="view.query=''">清除筛选</button></div>
    <p v-if="cards.length && !filtered.length" class="ws-empty">没有符合条件的技能，试试其他关键词。</p>
    <p v-if="selected && !currentCard" class="ws-muted">此技能已不存在或暂未载入。</p>
    <div v-if="!currentCard" class="skill-grid">
      <button
        v-for="card in filtered"
        :key="card.id"
        class="ws-panel skill-card"
        :class="{ active: selected === card.id }"
        @click="selected = selected === card.id ? '' : card.id"
      >
        <small v-if="card.parentId" class="ws-muted"
          >{{ cards.find((c) => c.id === card.parentId)?.name }} /</small
        >
        <h3>{{ card.name }}</h3>
        <p class="ws-muted">{{ card.summary || "尚未补充事实摘要" }}</p>
        <div
          v-for="metric in currentMetrics(card).slice(0, 3)"
          :key="metric.key"
          class="skill-value"
        >
          <span>{{ metric.label }}</span
          ><strong
            >{{
              latest(card, metric.key, metric.version)?.value ?? "暂无记录"
            }}
            {{
              latest(card, metric.key, metric.version) ? metric.unit : ""
            }}</strong
          >
        </div>
        <p v-if="!card.metrics.length" class="ws-muted">
          历史技能 · 原始描述已保留
        </p>
      </button>
    </div>
    <div v-if="currentCard" ref="detail" tabindex="-1" class="skill-detail-container">
    <button class="ws-button" @click="selected=''">返回技能列表</button>
    <article
      v-for="card in [currentCard]"
      :key="card.id"
      class="ws-panel skill-detail"
    >
      <header class="ws-section-head">
        <h2>{{ card.name }}</h2>
        <button
          class="ws-button"
          @click="
            emit(
              'compose',
              `为技能“${card.name}”追加一条事实记录，先读取现有指标。`,
            )
          "
        >
          记录新实践
        </button>
      </header>
      <div class="ws-toolbar">
        <button class="ws-button" @click="emit('edit', card.id)">
          编辑描述</button
        ><button class="ws-button danger" @click="emit('remove', card.id)">
          删除技能
        </button>
      </div>
      <p class="ws-pre">{{ card.summary }}</p>
      <section
        v-for="metric in card.metrics"
        :key="metric.key + metric.version"
      >
        <h3>
          {{ metric.label }}
          <small class="ws-muted"
            >{{ metric.unit }} · 口径 {{ metric.version }}</small
          >
        </h3>
        <MetricTrend
          v-if="metric.type === 'number'"
          :values="
            card.records
              .filter(
                (r) =>
                  r.metricKey === metric.key &&
                  r.version === metric.version &&
                  typeof r.value === 'number',
              )
              .map((r) => ({ id: r.id, date: r.date, value: Number(r.value) }))
          "
          :unit="metric.unit"
          :label="metric.label"
        />
        <div
          v-for="record in card.records.filter(
            (r) => r.metricKey === metric.key && r.version === metric.version,
          )"
          :key="record.id"
          class="skill-record"
        >
          <span>{{ record.date }}</span
          ><strong>{{ record.value }} {{ metric.unit }}</strong
          ><span class="ws-muted">{{ record.evidence }}</span
          ><button
            class="ws-button"
            :disabled="busy"
            @click="act(() => workspace.skills.undoRecord(record.id))"
          >
            撤销记录
          </button>
        </div>
      </section>
      <ResourceLinks owner="skill" :id="card.id" title="相关项目与凭证" />
    </article>
    </div>
  </section>
</template>
<style scoped>
.skill-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.skill-card {
  text-align: left;
  min-width: 0;
}
.skill-card.active {
  border-color: var(--accent);
}
.skill-card p {
  overflow-wrap: anywhere;
}
.skill-value {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  margin-top: 12px;
}
.skill-value strong {
  color: var(--accent);
}
.skill-draft,
.skill-detail {
  margin-bottom: 24px;
}
.skill-detail {
  margin-top: 24px;
}
.skill-draft label {
  display: block;
  font-size: 12px;
  margin: 12px 0;
}
.metric-edit {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 12px;
}
.skill-record {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  padding: 12px 0;
  border-bottom: 1px solid var(--divider);
  font-size: 12px;
}
.skill-record .ws-muted {
  flex: 1;
}
.skill-detail section {
  margin-top: 24px;
}
</style>
