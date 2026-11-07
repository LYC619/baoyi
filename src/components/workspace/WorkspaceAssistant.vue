<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {useArchiveAssistant} from "@/composables/useArchiveAssistant";
const archiveAssistant=useArchiveAssistant();
import { useRouter, useRoute } from "vue-router";
import {
  Sparkles,
  Send,
  Square,
  Plus,
  ChevronDown,
  ChevronUp,
} from "lucide-vue-next";
import { workspace, plain } from "@/utils/workspace-api";
import type {
  WorkspaceModule,
  WorkspaceAgentContext,
  WorkspaceSession,
  WorkspaceChange,
} from "@/types/workspace";
import {
  workspaceSources,
  type WorkspaceSource,
} from "@/utils/workspace-sources";
const props = defineProps<{
    module: WorkspaceModule;
    context?: WorkspaceAgentContext;
    inlineSources?: boolean;
    preserveContext?: boolean;
  }>(),
  router = useRouter(),
  route = useRoute();
const emit = defineEmits<{
  source: [source: WorkspaceSource];
  status: [running: boolean];
}>();
const sessions = ref<Array<Omit<WorkspaceSession, "messages">>>([]),
  session = ref<WorkspaceSession | null>(null),
  changes = ref<WorkspaceChange[]>([]),
  groupNames = ref<Record<string, string>>({}),
  draft = ref(""),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  expanded = ref(true);
const label = computed(() => (props.module === "personal" ? "个人" : "资料")),
  running = computed(() => session.value?.status === "running"),
  contextKey = (c: WorkspaceAgentContext = {}) =>
    JSON.stringify({
      documentIds: [...(c.documentIds || [])].sort(),
      selection: c.selection || null,
    });
watch(running, (value) => emit("status", value), { immediate: true });
let revision = 0;
let changesRevision = 0;
async function list() {
  const value = await workspace.agent.sessions(props.module);
  sessions.value = value.filter(
    (s) => contextKey(s.context) === contextKey(props.context),
  );
}
async function choose(id: string) {
  const run = ++revision;
  changesRevision++;
  error.value = "";
  try {
    const [value, audit, names] = await Promise.all([
      workspace.agent.session(id),
      workspace.agent.changes(id),
      loadGroupNames(props.module),
    ]);
    if (run === revision) {
      session.value = value;
      changes.value = audit;
      groupNames.value = names;
      expanded.value = true;
    }
  } catch (e) {
    if (run === revision) error.value = (e as Error).message;
  }
}
watch(
  () => [props.module, contextKey(props.context)],
  async () => {
    if (props.preserveContext && session.value) return;
    const run = ++revision;
    session.value = null;
    changes.value = [];
    groupNames.value = {};
    error.value = "";
    try {
      const value = await workspace.agent.sessions(props.module);
      if (run !== revision) return;
      sessions.value = value.filter(
        (s) => contextKey(s.context) === contextKey(props.context),
      );
      if (sessions.value[0]) await choose(sessions.value[0].id);
    } catch (e) {
      if (run === revision) error.value = (e as Error).message;
    }
  },
  { immediate: true },
);
async function loadGroupNames(module: WorkspaceModule): Promise<Record<string, string>> {
  if (module !== "document") return {};
  const [readingGroups, archiveGroups] = await Promise.all([
    workspace.documents.customGroups("reading"),
    workspace.documents.customGroups("archive"),
  ]);
  return Object.fromEntries([...readingGroups, ...archiveGroups].map(g => [g.id, g.name]));
}
async function refreshChanges(id: string) {
  const run = revision, request = ++changesRevision;
  try {
    const [value, names] = await Promise.all([
      workspace.agent.changes(id),
      loadGroupNames(props.module),
    ]);
    if (run === revision && request === changesRevision && session.value?.id === id) {
      changes.value = value;
      groupNames.value = names;
    }
  } catch (e) {
    if (run === revision && request === changesRevision && session.value?.id === id) error.value = (e as Error).message;
  }
}
const unsubscribe = workspace.agent.onSession((value) => {
  if (value.id === session.value?.id) {
    session.value = value;
    void refreshChanges(value.id);
  }
});
onBeforeUnmount(() => {
  revision++;
  unsubscribe();
});
async function send() { await sendText(draft.value.trim(), true); }
async function sendText(text: string, clearDraft = false) {
  if (!text || busy.value || running.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  expanded.value = true;
  try {
    if (!session.value)
      session.value = await workspace.agent.create(
        props.module,
        plain(props.context || {}),
      );
    const id = session.value.id;
    if (clearDraft) draft.value = "";
    const result = await workspace.agent.send(id, text);
    if (session.value?.id === id) session.value = result;
    await refreshChanges(id);
    await list();
  } catch (e) {
    error.value = (e as Error).message;
    if (clearDraft) draft.value = text;
  } finally {
    busy.value = false;
  }
}
async function continueDocuments() {
  await sendText('继续上次资料整理，使用已保存的资料列表续读位置，不重复从头翻页。列表读完后完成分组；保留已保存的修改和人工字段。');
}
function fresh() {
  if (running.value) return;
  revision++;
  session.value = null;
  changes.value = [];
  error.value = "";
  notice.value = "";
}
function compose(text: string) {
  const selection=props.context?.selection;
  void archiveAssistant.show(text+(selection?"\n选文：\n"+selection.quote:""),props.context?.documentIds||[]);
}
defineExpose({ compose });
function questions(message: {
  events: Array<{ label: string; detail: string }>;
}): Array<{ title: string; options: string[] }> {
  return message.events
    .filter((e) => e.label === "ask_personal_questions 结果")
    .flatMap((e) => {
      try {
        const value = JSON.parse(e.detail);
        return Array.isArray(value.questions)
          ? value.questions.filter(
              (q: any) =>
                typeof q.title === "string" &&
                Array.isArray(q.options) &&
                q.options.every((o: any) => typeof o === "string"),
            )
          : [];
      } catch {
        return [];
      }
    });
}
function sources(messageId: string) {
  return session.value ? workspaceSources(session.value, messageId) : [];
}
function searchSources(message: {
  events: Array<{ label: string; detail: string }>;
}): Array<{ title: string; url: string; snippet?: string }> {
  return message.events
    .filter((e) => e.label === "web_search 结果")
    .flatMap((e) => {
      try {
        const val = JSON.parse(e.detail);
        if (val && Array.isArray(val.results)) {
          return val.results.filter(
            (r: any) => typeof r.title === "string" && typeof r.url === "string",
          );
        }
        return [];
      } catch {
        return [];
      }
    });
}
function openExternal(url: string) {
  if (url) window.open(url, "_blank");
}
function openSource(source: WorkspaceSource, messageId: string, index: number) {
  if (props.inlineSources) emit("source", source);
  else if (session.value)
    void router.push({
      path: "/document/" + encodeURIComponent(source.documentId),
      query: {
        from: route.fullPath,
        sourceSession: session.value.id,
        message: messageId,
        source: String(index),
        page: String(source.location.page),
        offset: "0",
      },
    });
}
async function change(row: WorkspaceChange, apply = false) {
  if (!session.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (apply) await workspace.agent.apply(session.value.id, row.id);
    else
      notice.value = (
        await workspace.agent.undo(session.value.id, row.id)
      ).reason;
    await refreshChanges(session.value.id);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function stop() {
  if (session.value)
    try {
      await workspace.agent.cancel(session.value.id);
    } catch (e) {
      error.value = (e as Error).message;
    }
}
const names: Record<string, string> = {
  name: "名称",
  body: "说明",
  type: "分类",
  author: "作者",
  counterpart: "相关方",
  issuedOn: "取得日期",
  expiresOn: "到期日期",
  notes: "备注",
  tags: "标签",
  readState: "阅读状态",
  customGroupId: "分组",
  category: "类别",
  cost: "费用",
  currency: "币种",
  cycle: "周期",
  provider: "提供方",
  url: "管理入口",
  date: "日期",
  organization: "机构",
  practice: "实践",
  level: "自评",
  stages: "经历节点",
  unit: "单位",
  metricId: "指标",
  value: "数值",
  dueOn: "截止日期",
  done: "完成",
  motto: "签名",
};
const values: Record<string, string> = {
  monthly: "每月",
  yearly: "每年",
  once: "一次性",
  other: "其他",
  book: "书籍",
  paper: "论文",
  certificate: "证书",
  unread: "未读",
  reading: "在读",
  read: "已读",
};
function format(value: unknown, key?: string): string {
  if (value === undefined || value === null || value === "") return key === "customGroupId" ? "未分组" : "未填写";
  if (Array.isArray(value)) return value.map((v) => format(v, key)).join("、") || "未填写";
  if (key === "customGroupId") {
    return groupNames.value[String(value)] || String(value);
  }
  return values[String(value)] || String(value);
}
function fields(row: WorkspaceChange) {
  const after = { ...row.after, ...row.after.data },
    before = { ...row.before, ...row.before?.data };
  return Object.keys(names)
    .filter(
      (k) =>
        k in after &&
        (!row.before || JSON.stringify(before[k]) !== JSON.stringify(after[k])),
    )
    .map((k) => ({
      key: k,
      label: names[k],
      before: format(before[k], k),
      after: format(after[k], k),
    }));
}
function open(row: WorkspaceChange) {
  if (row.entity === "document") void router.push("/document/" + row.targetId);
  if (row.entity === "personal")
    void router.push({
      path: "/personal",
      query: {
        section:
          row.after.kind === "profile"
            ? "overview"
            : row.after.kind === "metric" || row.after.kind === "measurement"
              ? "state"
              : row.after.kind,
        record: row.targetId,
      },
    });
}
</script>
<template>
  <section class="workspace-assistant">
    <header>
      <Sparkles :size="17" />
      <h2>{{ module === "personal" ? "用一句话记下来" : "资料助手" }}</h2>
      <span class="ws-muted">{{
        running ? "正在处理，结果会逐步保存" : "直接登记 · 可编辑 · 可撤销"
      }}</span
      ><button
        v-if="session?.messages.length"
        class="ws-icon"
        :aria-label="expanded ? '收起助手会话' : '展开助手会话'"
        @click="expanded = !expanded"
      >
        <ChevronUp v-if="expanded" :size="17" /><ChevronDown
          v-else
          :size="17"
        />
      </button>
    </header>
    <div v-if="sessions.length" class="assistant-sessions">
      <select
        :value="session?.id || ''"
        :aria-label="label + '助手会话'"
        :disabled="busy || running"
        @change="choose(($event.target as HTMLSelectElement).value)"
      >
        <option disabled value="">新对话</option>
        <option v-for="s in sessions" :key="s.id" :value="s.id">
          {{ s.title }}
        </option></select
      ><button class="ws-button" :disabled="busy || running" @click="fresh">
        <Plus :size="14" />新对话
      </button>
    </div>
    <div v-if="expanded && session?.messages.length" class="assistant-output">
      <article
        v-for="message in session.messages"
        :key="message.id"
        class="assistant-message"
        :class="message.role"
      >
        <span>{{ message.role === "user" ? "你" : label + "助手" }}</span>
        <p class="ws-pre">{{ message.text || "正在读取资料或登记记录…" }}</p>
        <div
          v-for="(question, questionIndex) in questions(message)"
          :key="questionIndex"
          class="assistant-question"
        >
          <p>{{ question.title }}</p>
          <button
            v-for="option in question.options"
            :key="option"
            class="ws-button"
            :disabled="busy || running"
            @click="compose(question.title + '：' + option)"
          >
            {{ option }}
          </button>
        </div>
        <div v-if="sources(message.id).length" class="assistant-sources">
          <span class="ws-muted">本轮依据</span
          ><button
            v-for="(source, index) in sources(message.id)"
            :key="index"
            class="assistant-source"
            @click="openSource(source, message.id, index)"
          >
            {{ source.name }} · {{ source.label
            }}<small>{{ source.quote.slice(0, 100) }}</small>
          </button>
        </div>
        <div v-if="searchSources(message).length" class="assistant-search-sources">
          <span class="ws-muted">网络搜索证据</span>
          <button
            v-for="(source, index) in searchSources(message)"
            :key="index"
            class="assistant-search-source"
            type="button"
            :title="source.snippet || source.title"
            @click="openExternal(source.url)"
          >
            {{ source.title }}
            <small v-if="source.snippet">{{ source.snippet.slice(0, 100) }}</small>
          </button>
        </div>
        <details v-if="message.events.length">
          <summary>查看工具过程 · {{ message.events.length }} 项</summary>
          <section v-for="(event, index) in message.events" :key="index">
            <strong>{{ event.label }}</strong>
            <pre :class="{ 'ws-error': event.error }">{{ event.detail }}</pre>
          </section>
        </details>
      </article>
      <article
        v-for="row in changes"
        :key="row.id"
        class="assistant-change"
        :class="row.state"
      >
        <header>
          <strong>{{
            row.after.name || (row.entity === "link" ? "关联资源" : "记录修改")
          }}</strong
          ><span class="ws-badge"
            >AI 生成 ·
            {{
              row.state === "applied"
                ? "已保存"
                : row.state === "proposed"
                  ? "待确认"
                  : "已撤销"
            }}</span
          >
        </header>
        <p v-if="row.state === 'proposed'" class="ws-muted">
          这次会修改人工编辑的字段，确认差异后才会写入。
        </p>
        <dl>
          <template v-for="field in fields(row)" :key="field.key"
            ><dt>{{ field.label }}</dt>
            <dd>
              <span v-if="row.before" class="assistant-before"
                >{{ field.before }} → </span
              >{{ field.after }}
            </dd></template
          >
        </dl>
        <footer>
          <button
            v-if="row.entity !== 'link' && row.state !== 'undone'"
            class="ws-button"
            @click="open(row)"
          >
            查看 / 编辑</button
          ><button
            v-if="row.state === 'proposed'"
            class="ws-button primary"
            :disabled="busy || running"
            @click="change(row, true)"
          >
            应用修改</button
          ><button
            v-if="row.state !== 'undone'"
            class="ws-button"
            :disabled="busy || running"
            @click="change(row)"
          >
            {{ row.state === "proposed" ? "取消建议" : "撤销" }}
          </button>
        </footer>
      </article>
    </div>
    <p v-if="error || session?.error" class="ws-error" role="alert">
      {{ error || session?.error }}
    </p>
    <p v-if="notice" class="ws-notice" role="status">{{ notice }}</p>
    <section v-if="module === 'document' && session?.documentProgress" class="assistant-progress" aria-label="资料整理进度">
      <p role="status">资料列表已读取 {{ session.documentProgress.position }} / {{ session.documentProgress.total }} 项。{{ session.documentProgress.nextCursor ? '续读位置已保存。' : '列表已读完，分组结果请查看本会话修改记录。' }}</p>
      <p v-if="changes.length">本会话修改：已保存 {{ changes.filter(row => row.state === 'applied').length }} 项，待确认 {{ changes.filter(row => row.state === 'proposed').length }} 项。</p>
      <button v-if="session.status === 'interrupted' || session.status === 'failed' || session.documentProgress.nextCursor" type="button" class="ws-button" :disabled="busy || running" @click="continueDocuments">继续整理</button>
    </section>
    <form class="assistant-composer" @submit.prevent="send">
      <textarea
        v-model="draft"
        :aria-label="'给' + label + '助手的消息'"
        :placeholder="
          module === 'personal'
            ? '例如：新开了一个 VPS，每月 8 美元，11 月 20 日到期'
            : '例如：帮我分类并补全这些资料，保留我已选的分类'
        "
        rows="2"
        maxlength="12000"
        :disabled="busy || running"
      /><button v-if="running" class="ws-button" type="button" @click="stop">
        <Square :size="15" />停止</button
      ><button
        v-else
        class="ws-button primary"
        type="submit"
        :disabled="busy || !draft.trim()"
      >
        <Send :size="15" />发送给助手
      </button>
    </form>
  </section>
</template>
<style scoped>
.assistant-progress { margin: 12px 0; padding: 10px 12px; border: 1px solid var(--divider); border-radius: 5px; font-size: 12px; }
.assistant-progress p { margin: 0 0 8px; line-height: 1.7; }
.assistant-question {
  padding: 10px 0;
}
.assistant-question button {
  margin: 4px;
  font-size: 12px;
}
.assistant-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 9px 0;
}
.assistant-search-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 9px 0;
}
.assistant-search-sources > span {
  width: 100%;
  font-size: 11px;
}
.assistant-search-source {
  text-align: left;
  border: 1px solid var(--divider);
  border-radius: 4px;
  padding: 7px 9px;
  background: var(--bg-main);
  font-size: 12px;
  color: var(--accent);
  max-width: 100%;
  cursor: pointer;
}
.assistant-search-source:hover {
  text-decoration: underline;
}
.assistant-search-source small {
  display: block;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
  font-size: 11px;
  margin-top: 4px;
}
.assistant-sources > span {
  width: 100%;
  font-size: 11px;
}
.assistant-source {
  text-align: left;
  border: 1px solid var(--divider);
  border-radius: 4px;
  padding: 7px 9px;
  background: var(--bg-main);
  font-size: 12px;
  color: var(--accent);
  max-width: 100%;
}
.assistant-source small {
  display: block;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
  font-size: 11px;
  margin-top: 4px;
}
.workspace-assistant {
  border: 1px solid var(--divider);
  border-radius: 7px;
  margin: 0 0 25px;
  background: var(--ws-tint);
  padding: 16px 18px;
}
.workspace-assistant > header {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--accent);
  margin-bottom: 12px;
}
.workspace-assistant h2 {
  font-size: 15px;
  font-weight: 500;
  margin: 0;
}
.workspace-assistant > header > .ws-muted {
  font-size: 11px;
  flex: 1;
}
.assistant-sessions {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.assistant-sessions select {
  flex: 1;
  min-width: 0;
}
.assistant-composer {
  display: flex;
  gap: 12px;
  align-items: flex-end;
}
.assistant-composer textarea {
  flex: 1;
  min-width: 0;
  resize: vertical;
  min-height: 64px;
  background: var(--bg-main);
}
.assistant-composer button {
  flex-shrink: 0;
}
.assistant-output {
  max-height: 420px;
  overflow: auto;
  border-top: 1px solid var(--divider);
  margin: 12px 0;
  padding: 12px 3px;
}
.assistant-message {
  margin: 0 0 16px;
}
.assistant-message > span {
  font-size: 11px;
  color: var(--text-sub);
}
.assistant-message.user > p {
  color: var(--text-sub);
}
.assistant-message p {
  font-size: 13px;
  line-height: 1.85;
  margin: 5px 0;
  overflow-wrap: anywhere;
}
.assistant-message summary {
  font-size: 11px;
  color: var(--text-sub);
  cursor: pointer;
}
.assistant-message pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  background: var(--bg-main);
  padding: 10px;
  max-height: 240px;
  overflow: auto;
}
.assistant-message details strong {
  font-size: 11px;
  font-weight: 500;
}
.assistant-change {
  border: 1px solid var(--divider);
  border-left: 3px solid var(--accent);
  border-radius: 5px;
  background: var(--bg-main);
  padding: 14px;
  margin: 10px 0;
}
.assistant-change.undone {
  opacity: 0.65;
}
.assistant-change > header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.assistant-change strong {
  font-size: 13px;
  font-weight: 500;
}
.assistant-change dl {
  display: grid;
  grid-template-columns: 70px 1fr;
  font-size: 12px;
  gap: 7px;
  line-height: 1.7;
  margin: 12px 0;
}
.assistant-change dt {
  color: var(--text-sub);
}
.assistant-change dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.assistant-before {
  color: var(--text-sub);
}
.assistant-change footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.assistant-change footer > .ws-button {
  padding: 4px 9px;
  font-size: 11px;
}
@media (max-width: 1000px) {
  .assistant-composer {
    flex-wrap: wrap;
  }
  .assistant-composer textarea {
    flex-basis: 100%;
  }
  .workspace-assistant > header {
    flex-wrap: wrap;
  }
}
</style>
