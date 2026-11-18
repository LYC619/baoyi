<script setup lang="ts">
import { errorMessage } from '@/utils'
import { ref, onMounted, computed } from "vue";
import ProjectDialog from "@/components/project/ProjectDialog.vue";
import { workspace, plain, localDate } from "@/utils/workspace-api";
import { DEFAULT_MODULE_PREFERENCES } from "@/types/workspace";
import type {
  PersonalKind,
  PersonalRecord,
  PersonalInput,
  PersonalData,
} from "@/types/workspace";
const props = defineProps<{
    kind: PersonalKind;
    record?: PersonalRecord;
    metrics?: PersonalRecord[];
    metricId?: string;
  }>(),
  emit = defineEmits<{ close: []; saved: [record: PersonalRecord] }>();
const labels: Record<PersonalKind, string> = {
  profile: "个人信息",
  asset: "背包资产",
  skill: "技能",
  experience: "奖项与经历",
  metric: "状态指标",
  measurement: "状态记录",
  todo: "待办",
};
const defaults: Record<PersonalKind, PersonalData> = {
  profile: { motto: "" },
  asset: {
    category: "服务",
    cost: "",
    currency: "CNY",
    cycle: "yearly",
    expiresOn: "",
    url: "",
    provider: "",
  },
  skill: { stages: [], practice: "", level: "" },
  experience: { date: localDate(), organization: "", category: "经历" },
  metric: { unit: "" },
  measurement: {
    metricId: props.metricId || props.metrics?.[0]?.id || "",
    value: 0,
    date: localDate(),
  },
  todo: { dueOn: "", done: false },
};
const form = ref<PersonalInput>({
    ...(props.record ? { id: props.record.id } : {}),
    kind: props.kind,
    name:
      props.record?.name || (props.kind === "measurement" ? "状态记录" : ""),
    body: props.record?.body || "",
    data: plain(props.record?.data || defaults[props.kind]),
  }),
  busy = ref(false),
  error = ref("");
const preferences = ref(structuredClone(DEFAULT_MODULE_PREFERENCES));
onMounted(async () => {
  try {
    preferences.value = await workspace.preferences.get("personal");
  } catch (e) {
    error.value = errorMessage(e);
  }
});
const categories = computed(() => [
  ...new Set(
    [
      ...(props.kind === "asset"
        ? preferences.value.assetCategories
        : preferences.value.experienceCategories),
      String(form.value.data.category || ""),
    ].filter(Boolean),
  ),
]);
async function chooseAvatar() {
  error.value = "";
  busy.value = true;
  try {
    const avatar = await workspace.personal.chooseAvatar();
    if (avatar) form.value.data.avatar = avatar;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const value = await workspace.personal.save(plain(form.value));
    emit("saved", value);
    emit("close");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <ProjectDialog
    :title="(record ? '编辑' : '添加') + labels[kind]"
    :busy="busy"
    @close="emit('close')"
    ><form id="personal-form" class="ws ws-form" @submit.prevent="save">
      <p v-if="error" class="ws-error" role="alert">{{ error }}</p>
      <label
        >{{ kind === "profile" ? "称呼" : "名称"
        }}<input v-model="form.name" required maxlength="300"
      /></label>
      <div v-if="kind === 'profile'" class="avatar-editor">
        <img
          v-if="form.data.avatar"
          :src="String(form.data.avatar)"
          alt="头像预览"
          width="72"
          height="72"
          style="border-radius: 12px"
        /><button
          type="button"
          class="ws-button"
          :disabled="busy"
          @click="chooseAvatar"
        >
          选择头像</button
        ><button
          v-if="form.data.avatar"
          type="button"
          class="ws-button"
          @click="form.data.avatar = ''"
        >
          移除头像
        </button>
      </div>
      <label v-if="kind === 'profile'"
        >一句话介绍<input v-model="form.data.motto" maxlength="2000"
      /></label>
      <template v-if="kind === 'asset'"
        ><div class="ws-two">
          <label
            >资产类别<select v-model="form.data.category" aria-label="类别">
              <option v-for="category in categories" :key="category">
                {{ category }}
              </option>
            </select></label
          ><label>提供方<input v-model="form.data.provider" /></label>
        </div>
        <div class="ws-two">
          <label
            >费用<input
              v-model.number="form.data.cost"
              type="number"
              min="0"
              max="1000000000"
              step="0.01" /></label
          ><label
            >币种<input
              v-model="form.data.currency"
              list="personal-currencies"
              placeholder="CNY / 人民币"
              maxlength="20" /><datalist id="personal-currencies">
              <option value="CNY" />
              <option value="USD" />
              <option value="EUR" />
              <option value="JPY" />
              <option value="HKD" /></datalist
          ></label>
        </div>
        <div class="ws-two">
          <label
            >付费周期<select v-model="form.data.cycle" aria-label="付费周期">
              <option value="once">一次性</option>
              <option value="monthly">每月</option>
              <option value="yearly">每年</option>
              <option value="other">其他</option>
            </select></label
          ><label
            >到期日期<input v-model="form.data.expiresOn" type="date"
          /></label>
        </div>
        <label
          >管理入口<input
            v-model="form.data.url"
            type="url"
            placeholder="https://…" /></label
      ></template>
      <template v-if="kind === 'experience'"
        ><div class="ws-two">
          <label>日期<input v-model="form.data.date" type="date" /></label
          ><label
            >类型<select v-model="form.data.category" aria-label="类别">
              <option v-for="category in categories" :key="category">
                {{ category }}
              </option>
            </select></label
          >
        </div>
        <label>机构 / 场合<input v-model="form.data.organization" /></label
      ></template>
      <label v-if="kind === 'metric'"
        >单位<input v-model="form.data.unit" placeholder="小时、kg、次…"
      /></label>
      <p v-if="kind === 'metric' && record" class="ws-muted">已有记录的指标只可改名；需要更换单位时请新建指标，历史数值保留原单位。</p>
      <template v-if="kind === 'measurement'"
        ><label
          >指标<select v-model="form.data.metricId" aria-label="指标" required>
            <option
              v-for="metric in metrics"
              :key="metric.id"
              :value="metric.id"
            >
              {{ metric.name }}（{{ metric.data.unit || "无单位" }}）
            </option>
          </select></label
        >
        <div class="ws-two">
          <label
            >数值<input
              v-model.number="form.data.value"
              required
              type="number"
              step="any"
              min="-1000000"
              max="1000000" /></label
          ><label
            >记录日期<input v-model="form.data.date" required type="date"
          /></label></div
      ></template>
      <template v-if="kind === 'todo'"
        ><label>计划日期<input v-model="form.data.dueOn" type="date" /></label
        ><label class="check"
          ><input v-model="form.data.done" type="checkbox" />已完成</label
        ></template
      >
      <label v-if="kind !== 'profile'"
        >{{
          kind === "skill"
            ? "事实与实践"
            : kind === "asset"
              ? "用途与备注"
              : "补充记录"
        }}<textarea v-model="form.body" maxlength="30000" />
      </label>
    </form>
    <template #footer
      ><div class="ws">
        <button
          class="ws-button primary"
          type="submit"
          form="personal-form"
          :disabled="busy"
        >
          保存个人记录
        </button>
      </div></template
    ></ProjectDialog
  >
</template>
