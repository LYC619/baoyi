<script setup lang="ts">
import { errorMessage } from '@/utils'
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { Plus, Sparkles } from "lucide-vue-next";
import { workspace, plain, localDate } from "@/utils/workspace-api";
import type { SkillCard, SkillDraft, SkillProposal } from "@/types/skill-profile";
import { useRoute, useRouter } from "vue-router";
import { usePersonalView } from "@/composables/usePersonalView";
import ProjectDialog from "@/components/project/ProjectDialog.vue";
import SkillTree from "./SkillTree.vue";
import MetricTrend from "./MetricTrend.vue";
import ResourceLinks from "@/components/workspace/ResourceLinks.vue";

const emit = defineEmits<{
  compose: [text: string];
  edit: [id: string];
  remove: [id: string];
}>();

const route = useRoute(), router = useRouter();
const selected = computed({
  get: () => typeof route.query.record === 'string' ? route.query.record : '',
  set: (value) => {
    const query = { ...route.query };
    if (value) query.record = value;
    else delete query.record;
    void router.replace({ path: route.path, query });
  }
});

const view = usePersonalView('skills', { query: '' });
const detail = ref<HTMLElement>();
watch(selected, async (value) => { if (value) { await nextTick(); detail.value?.focus() } });

const cards = ref<SkillCard[]>([]),
  proposals = ref<SkillProposal[]>([]),
  error = ref(""),
  busy = ref(false);

const cardDialog = ref(false);
const cardFormError = ref("");
const cardForm = ref<{
  cardId?: string;
  name: string;
  summary: string;
  parentId: string;
  metrics: Array<{ key: string; label: string; unit: string; type: "number" | "text" | "date" }>;
}>({
  name: "",
  summary: "",
  parentId: "",
  metrics: [{ key: "metric_1", label: "", unit: "", type: "number" }],
});

const recordDialog = ref(false);
const recordFormError = ref("");
const recordForm = ref<{
  metricKey: string;
  value: string | number;
  date: string;
  evidence: string;
}>({
  metricKey: "",
  value: "",
  date: localDate(),
  evidence: "",
});

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

const filtered = computed(() =>
  cards.value.filter((c) =>
    [c.name, c.summary, ...c.metrics.map((m) => m.label)]
      .join(' ')
      .toLocaleLowerCase()
      .includes(view.query.trim().toLocaleLowerCase()),
  ),
);
const currentCard = computed(() => cards.value.find((c) => c.id === selected.value));
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

function openCreate(existing?: SkillCard) {
  cardFormError.value = "";
  const activeMetrics = existing ? currentMetrics(existing) : [];
  cardForm.value = {
    ...(existing ? { cardId: existing.id } : {}),
    name: existing?.name || "",
    summary: existing?.summary || "",
    parentId: existing?.parentId || "",
    metrics: activeMetrics.length
      ? activeMetrics.map((m) => ({ key: m.key, label: m.label, unit: m.unit, type: m.type }))
      : [{ key: "metric_1", label: "", unit: "", type: "number" }],
  };
  cardDialog.value = true;
}

function addMetricRow() {
  if (cardForm.value.metrics.length >= 12) return;
  cardForm.value.metrics.push({
    key: `metric_${Date.now().toString(36)}_${cardForm.value.metrics.length + 1}`,
    label: "",
    unit: "",
    type: "number",
  });
}

function removeMetricRow(index: number) {
  if (cardForm.value.metrics.length <= 1) return;
  cardForm.value.metrics.splice(index, 1);
}

async function submitManualCard() {
  if (busy.value) return;
  busy.value = true;
  cardFormError.value = "";
  try {
    const usedKeys = new Set<string>();
    const metrics = cardForm.value.metrics.map((m, idx) => {
      const label = m.label.trim();
      if (!label) throw new Error(`请填写第 ${idx + 1} 项指标名称`);
      let key = (m.key || `metric_${idx + 1}`).trim();
      while (usedKeys.has(key)) key = `${key}_${idx + 1}`;
      usedKeys.add(key);
      return { key, label, unit: m.unit.trim(), type: m.type };
    });
    const payload: SkillDraft = {
      ...(cardForm.value.cardId ? { cardId: cardForm.value.cardId } : {}),
      name: cardForm.value.name.trim(),
      summary: cardForm.value.summary.trim(),
      parentId: cardForm.value.parentId || "",
      metrics,
    };
    const saved = await workspace.skills.save(plain(payload));
    cardDialog.value = false;
    await load();
    selected.value = saved.id;
  } catch (e) {
    cardFormError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

function openRecordDialog(card: SkillCard) {
  const metrics = currentMetrics(card);
  if (!metrics.length) {
    openCreate(card);
    return;
  }
  recordFormError.value = "";
  recordForm.value = {
    metricKey: metrics[0].key,
    value: "",
    date: localDate(),
    evidence: "",
  };
  recordDialog.value = true;
}

const selectedRecordMetric = computed(() =>
  currentCard.value ? currentMetrics(currentCard.value).find((m) => m.key === recordForm.value.metricKey) : undefined,
);

async function submitManualRecord() {
  const card = currentCard.value;
  const metric = selectedRecordMetric.value;
  if (!card || !metric || busy.value) return;
  busy.value = true;
  recordFormError.value = "";
  try {
    const rawVal = recordForm.value.value;
    const finalVal =
      metric.type === "number"
        ? typeof rawVal === "number"
          ? rawVal
          : Number(String(rawVal).trim())
        : String(rawVal).trim();
    if (metric.type === "number" && !Number.isFinite(finalVal)) {
      throw new Error("请填写有效数字");
    }
    await workspace.skills.record({
      cardId: card.id,
      metricKey: metric.key,
      version: metric.version,
      value: finalVal,
      date: recordForm.value.date,
      requestId: crypto.randomUUID(),
      evidence: recordForm.value.evidence.trim() || "手动记录",
    });
    recordDialog.value = false;
    await load();
  } catch (e) {
    recordFormError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

defineExpose({ openCreate });
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
      <label>技能名称<input v-model="proposal.draft.name" maxlength="300" /></label>
      <label>事实摘要<textarea v-model="proposal.draft.summary" maxlength="10000" /></label>
      <div
        v-for="metric in proposal.draft.metrics"
        :key="metric.key"
        class="metric-edit"
      >
        <label>指标<input v-model="metric.label" maxlength="300" /></label>
        <label>单位<input v-model="metric.unit" maxlength="50" /></label>
        <label>类型<select v-model="metric.type">
          <option value="number">数值</option>
          <option value="text">文本</option>
          <option value="date">日期</option>
        </select></label>
      </div>
      <p class="ws-muted">
        新口径另存版本，历史记录保留原单位和定义，不混合绘图。
      </p>
      <div class="ws-toolbar">
        <button
          class="ws-button primary"
          :disabled="busy"
          @click="act(() => workspace.skills.confirm(proposal.id, plain(proposal.draft)))"
        >
          确认录入
        </button>
        <button
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
      <p>可以直接手动创建技能卡片和指标，也可以让归档助理从已有记录中帮你整理草案。</p>
      <div class="skill-empty-actions">
        <button class="ws-button primary" @click="openCreate()">
          <Plus :size="15" />新建技能卡片
        </button>
        <button
          class="ws-button"
          @click="emit('compose', '帮我建立一张技能卡片，先查已有技能和相关资源。')"
        >
          <Sparkles :size="15" />让归档助理帮忙整理
        </button>
      </div>
    </div>
    <details v-if="cards.some((c) => c.parentId)" class="skill-hierarchy">
      <summary>技能层级</summary>
      <SkillTree :cards="cards" @select="selected = $event" />
    </details>
    <div class="ws-toolbar">
      <input v-model="view.query" aria-label="搜索技能" placeholder="搜索技能、实践摘要或指标" />
      <small class="ws-muted" role="status">{{ filtered.length }} / {{ cards.length }} 项技能</small>
      <button v-if="view.query" class="ws-button" @click="view.query = ''">清除筛选</button>
    </div>
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
        <small v-if="card.parentId" class="ws-muted">{{ cards.find((c) => c.id === card.parentId)?.name }} /</small>
        <h3>{{ card.name }}</h3>
        <p class="ws-muted">{{ card.summary || "尚未补充事实摘要" }}</p>
        <div
          v-for="metric in currentMetrics(card).slice(0, 3)"
          :key="metric.key"
          class="skill-value"
        >
          <span>{{ metric.label }}</span>
          <strong>
            {{ latest(card, metric.key, metric.version)?.value ?? "暂无记录" }}
            {{ latest(card, metric.key, metric.version) ? metric.unit : "" }}
          </strong>
        </div>
        <p v-if="!card.metrics.length" class="ws-muted">
          历史技能 · 原始描述已保留
        </p>
      </button>
    </div>
    <div v-if="currentCard" ref="detail" tabindex="-1" class="skill-detail-container">
      <button class="ws-button" @click="selected = ''">返回技能列表</button>
      <article
        v-for="card in [currentCard]"
        :key="card.id"
        class="ws-panel skill-detail"
      >
        <header class="ws-section-head">
          <h2>{{ card.name }}</h2>
          <div class="ws-toolbar">
            <button class="ws-button primary" @click="openRecordDialog(card)">
              <Plus :size="14" />{{ card.metrics.length ? '记一次实践' : '补充指标并记录' }}
            </button>
            <button
              class="ws-button"
              @click="emit('compose', `为技能“${card.name}”追加一条事实记录，先读取现有指标。`)"
            >
              <Sparkles :size="14" />让助理帮记
            </button>
          </div>
        </header>
        <div class="ws-toolbar">
          <button class="ws-button" @click="openCreate(card)">编辑技能与指标</button>
          <button class="ws-button" @click="emit('edit', card.id)">编辑描述</button>
          <button class="ws-button danger" @click="emit('remove', card.id)">删除技能</button>
        </div>
        <p class="ws-pre">{{ card.summary }}</p>
        <section
          v-for="metric in card.metrics"
          :key="metric.key + metric.version"
        >
          <h3>
            {{ metric.label }}
            <small class="ws-muted">{{ metric.unit }} · 口径 {{ metric.version }}</small>
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
            <span>{{ record.date }}</span>
            <strong>{{ record.value }} {{ metric.unit }}</strong>
            <span class="ws-muted">{{ record.evidence }}</span>
            <button
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

    <ProjectDialog
      v-if="cardDialog"
      :title="cardForm.cardId ? '编辑技能卡片与指标' : '新建技能卡片'"
      :busy="busy"
      @close="cardDialog = false"
    >
      <form id="manual-skill-card-form" class="ws ws-form" @submit.prevent="submitManualCard">
        <p v-if="cardFormError" class="ws-error" role="alert">{{ cardFormError }}</p>
        <label>技能名称<input v-model="cardForm.name" required maxlength="300" placeholder="例如：跑步、吉他、英语阅读" /></label>
        <label v-if="cards.filter((c) => c.id !== cardForm.cardId).length">
          上级技能（可选）
          <select v-model="cardForm.parentId" aria-label="上级技能">
            <option value="">无上级技能</option>
            <option v-for="c in cards.filter((x) => x.id !== cardForm.cardId)" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label>实践摘要<textarea v-model="cardForm.summary" rows="3" maxlength="10000" placeholder="记录常用方法、阶段目标或代表成果（可选）" /></label>
        <div class="skill-metrics-editor">
          <div class="ws-section-head">
            <strong>衡量指标（1–12 项）</strong>
            <button type="button" class="ws-button" :disabled="cardForm.metrics.length >= 12" @click="addMetricRow">+ 添加指标</button>
          </div>
          <div v-for="(m, idx) in cardForm.metrics" :key="m.key" class="metric-edit-row">
            <input v-model="m.label" required maxlength="300" :aria-label="`指标名称 ${idx + 1}`" placeholder="指标名，如 10公里用时 / 完成曲目" />
            <input v-model="m.unit" maxlength="50" :aria-label="`指标单位 ${idx + 1}`" placeholder="单位，如 分钟 / 首" />
            <select v-model="m.type" :aria-label="`指标类型 ${idx + 1}`">
              <option value="number">数值</option>
              <option value="text">文本</option>
              <option value="date">日期</option>
            </select>
            <button v-if="cardForm.metrics.length > 1" type="button" class="ws-icon" aria-label="移除此指标" @click="removeMetricRow(idx)">×</button>
          </div>
          <p class="ws-muted">修改已有指标的单位或类型时会自动保存为新口径版本，不会改乱历史记录。</p>
        </div>
      </form>
      <template #footer>
        <div class="ws ws-toolbar">
          <button type="button" class="ws-button" :disabled="busy" @click="cardDialog = false">取消</button>
          <button type="submit" form="manual-skill-card-form" class="ws-button primary" :disabled="busy">保存技能卡片</button>
        </div>
      </template>
    </ProjectDialog>

    <ProjectDialog
      v-if="recordDialog && currentCard"
      :title="`记一次实践 · ${currentCard.name}`"
      :busy="busy"
      @close="recordDialog = false"
    >
      <form id="manual-skill-record-form" class="ws ws-form" @submit.prevent="submitManualRecord">
        <p v-if="recordFormError" class="ws-error" role="alert">{{ recordFormError }}</p>
        <label>
          选择指标
          <select v-model="recordForm.metricKey" aria-label="记录指标" required>
            <option v-for="m in currentMetrics(currentCard)" :key="m.key" :value="m.key">
              {{ m.label }}{{ m.unit ? `（${m.unit}）` : '' }}
            </option>
          </select>
        </label>
        <div class="ws-two">
          <label>
            {{ selectedRecordMetric?.type === 'number' ? `本次数值${selectedRecordMetric.unit ? '（' + selectedRecordMetric.unit + '）' : ''}` : selectedRecordMetric?.type === 'date' ? '日期值' : '记录内容' }}
            <input
              v-if="selectedRecordMetric?.type === 'number'"
              v-model.number="recordForm.value"
              type="number"
              step="any"
              required
              aria-label="实践数值"
            />
            <input
              v-else-if="selectedRecordMetric?.type === 'date'"
              v-model="recordForm.value"
              type="date"
              required
              aria-label="实践日期值"
            />
            <input
              v-else
              v-model="recordForm.value"
              type="text"
              required
              maxlength="4000"
              aria-label="实践内容"
              placeholder="例如：完成一首指弹曲目"
            />
          </label>
          <label>实践日期<input v-model="recordForm.date" type="date" required aria-label="实践发生日期" /></label>
        </div>
        <label>实践说明 / 凭证备注<input v-model="recordForm.evidence" maxlength="4000" aria-label="实践说明" placeholder="例如：晨跑记录、课堂练习或作品链接（可选）" /></label>
      </form>
      <template #footer>
        <div class="ws ws-toolbar">
          <button type="button" class="ws-button" :disabled="busy" @click="recordDialog = false">取消</button>
          <button type="submit" form="manual-skill-record-form" class="ws-button primary" :disabled="busy">保存这次记录</button>
        </div>
      </template>
    </ProjectDialog>
  </section>
</template>
<style scoped>
.skill-empty-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.skill-metrics-editor {
  display: grid;
  gap: 10px;
}
.metric-edit-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) 92px auto;
  gap: 8px;
  align-items: center;
}
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
@media (max-width: 640px) {
  .metric-edit-row {
    grid-template-columns: 1fr;
  }
}
</style>
