<script setup lang="ts">
import { tr } from "../../i18n/index.ts"

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
  get profile() { return tr('个人信息') },
  get asset() { return tr('背包资产') },
  get skill() { return tr('技能') },
  get experience() { return tr('奖项与经历') },
  get metric() { return tr('状态指标') },
  get measurement() { return tr('状态记录') },
  get todo() { return tr('待办') },
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
    name: props.record?.name || "",
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
    const name = form.value.name.trim() || (props.kind === 'measurement' ? tr('状态记录') : '');
    const value = await workspace.personal.save(plain({ ...form.value, name }));
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
    :title="(record ? $t('编辑') : $t('添加')) + labels[kind]"
    :busy="busy"
    @close="emit('close')"
    ><form id="personal-form" class="ws ws-form" @submit.prevent="save">
      <p v-if="error" class="ws-error" role="alert">{{ $systemMessage(error) }}</p>
      <label
        >{{ kind === "profile" ? $t('称呼') : $t('名称')
        }}<input v-model="form.name" :placeholder="kind === 'measurement' ? $t('状态记录') : ''" :required="kind !== 'measurement'" maxlength="300"
      /></label>
      <div v-if="kind === 'profile'" class="avatar-editor">
        <img
          v-if="form.data.avatar"
          :src="String(form.data.avatar)"
          :alt="$t('头像预览')"
          width="72"
          height="72"
          style="border-radius: 12px"
        /><button
          type="button"
          class="ws-button"
          :disabled="busy"
          @click="chooseAvatar"
        >{{ $t("选择头像") }}</button
        ><button
          v-if="form.data.avatar"
          type="button"
          class="ws-button"
          @click="form.data.avatar = ''"
        >{{ $t("移除头像") }}</button>
      </div>
      <label v-if="kind === 'profile'"
        >{{ $t("一句话介绍") }}<input v-model="form.data.motto" maxlength="2000"
      /></label>
      <template v-if="kind === 'asset'"
        ><div class="ws-two">
          <label
            >{{ $t("资产类别") }}<select v-model="form.data.category" :aria-label="$t('类别')">
              <option v-for="category in categories" :key="category">
                {{ category }}
              </option>
            </select></label
          ><label>{{ $t("提供方") }}<input v-model="form.data.provider" /></label>
        </div>
        <div class="ws-two">
          <label
            >{{ $t("费用") }}<input
              v-model.number="form.data.cost"
              type="number"
              min="0"
              max="1000000000"
              step="0.01" /></label
          ><label
            >{{ $t("币种") }}<input
              v-model="form.data.currency"
              list="personal-currencies"
              :placeholder="$t('CNY / 人民币')"
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
            >{{ $t("付费周期") }}<select v-model="form.data.cycle" :aria-label="$t('付费周期')">
              <option value="once">{{ $t("一次性") }}</option>
              <option value="monthly">{{ $t("每月") }}</option>
              <option value="yearly">{{ $t("每年") }}</option>
              <option value="other">{{ $t("其他") }}</option>
            </select></label
          ><label
            >{{ $t("到期日期") }}<input v-model="form.data.expiresOn" type="date"
          /></label>
        </div>
        <label
          >{{ $t("管理入口") }}<input
            v-model="form.data.url"
            type="url"
            placeholder="https://…" /></label
      ></template>
      <template v-if="kind === 'experience'"
        ><div class="ws-two">
          <label>{{ $t("日期") }}<input v-model="form.data.date" type="date" /></label
          ><label
            >{{ $t("类型") }}<select v-model="form.data.category" :aria-label="$t('类别')">
              <option v-for="category in categories" :key="category">
                {{ category }}
              </option>
            </select></label
          >
        </div>
        <label>{{ $t("机构 / 场合") }}<input v-model="form.data.organization" /></label
      ></template>
      <label v-if="kind === 'metric'"
        >{{ $t("单位") }}<input v-model="form.data.unit" :placeholder="$t('小时、kg、次…')"
      /></label>
      <p v-if="kind === 'metric' && record" class="ws-muted">{{ $t("已有记录的指标只可改名；需要更换单位时请新建指标，历史数值保留原单位。") }}</p>
      <template v-if="kind === 'measurement'"
        ><label
          >{{ $t("指标") }}<select v-model="form.data.metricId" :aria-label="$t('指标')" required>
            <option
              v-for="metric in metrics"
              :key="metric.id"
              :value="metric.id"
            >
              {{ metric.name }}（{{ metric.data.unit || $t('无单位') }}）
            </option>
          </select></label
        >
        <div class="ws-two">
          <label
            >{{ $t("数值") }}<input
              v-model.number="form.data.value"
              required
              type="number"
              step="any"
              min="-1000000"
              max="1000000" /></label
          ><label
            >{{ $t("记录日期") }}<input v-model="form.data.date" required type="date"
          /></label></div
      ></template>
      <template v-if="kind === 'todo'"
        ><label>{{ $t("计划日期") }}<input v-model="form.data.dueOn" type="date" /></label
        ><label class="check"
          ><input v-model="form.data.done" type="checkbox" />{{ $t("已完成") }}</label
        ></template
      >
      <label v-if="kind !== 'profile'"
        >{{
          kind === "skill"
            ? $t('事实与实践')
            : kind === "asset"
              ? $t('用途与备注')
              : $t('补充记录')
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
        >{{ $t("保存个人记录") }}</button>
      </div></template
    ></ProjectDialog
  >
</template>
