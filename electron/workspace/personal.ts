import { randomUUID } from "node:crypto";
import type { SqlDb } from "../services/storage/schema.ts";
import {
  PERSONAL_KINDS,
  type PersonalInput,
  type PersonalRecord,
  type PersonalKind,
  type PersonalData,
  type AssetRenewal,
  type AssetRenewalInput,
} from "../../src/types/workspace.ts";
import { renewalDate } from '../../src/utils/personal-assets.ts';
import * as v from "./validation.ts";
const allowed: Record<PersonalKind, string[]> = {
  profile: ["motto", "avatar"],
  asset: [
    "category",
    "cost",
    "currency",
    "cycle",
    "expiresOn",
    "url",
    "provider",
    "snoozedUntil",
    "renewals",
  ],
  skill: ["stages", "practice", "level"],
  experience: ["date", "organization", "category"],
  metric: ["unit"],
  measurement: ["metricId", "value", "date"],
  todo: ["dueOn", "done"],
};
function currencyCode(value: unknown): string {
  const code = v.text(value, '币种', 20).trim().toUpperCase();
  const result = ({人民币:'CNY',元:'CNY',RMB:'CNY',美元:'USD',美金:'USD',欧元:'EUR',日元:'JPY',港币:'HKD'} as Record<string,string>)[code] || code;
  if (result && !/^[A-Z]{3}$/.test(result)) throw new Error('币种请使用 CNY、USD 等三位代码');
  return result;
}
export function validatePersonal(input: PersonalInput): PersonalInput {
  v.keys(input, ["id", "kind", "name", "body", "data"]);
  if (!PERSONAL_KINDS.includes(input.kind)) throw new Error("个人记录类型无效");
  v.keys(input.data, allowed[input.kind]);
  const data: PersonalData = {};
  for (const [key, value] of Object.entries(input.data)) {
    if (key === "avatar") {
      const avatar = v.text(value, "头像", 400000);
      if (
        avatar &&
        !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(avatar)
      )
        throw new Error("请选择有效的 PNG 头像");
      data[key] = avatar;
    } else if (key === 'snoozedUntil') {
      data[key] = v.date(value);
      if (!data[key]) throw new Error('暂缓日期无效');
    } else if (["expiresOn", "date", "dueOn"].includes(key))
      data[key] = v.date(value);
    else if (key === "cost") {
      if (value !== "") data[key] = v.number(value, "费用", 0, 1000000000);
    } else if (key === "currency") {
      data[key] = currencyCode(value);
    } else if (key === 'renewals') {
      if (!Array.isArray(value)) throw new Error('续费记录无效');
      data.renewals = value.map(raw => {
        const entry = v.object(raw);
        v.keys(entry, ['on', 'from', 'to', 'cost', 'currency']);
        const result: AssetRenewal = { on: v.date(entry.on), from: v.date(entry.from), to: v.date(entry.to) };
        if (!result.on || !result.to) throw new Error('续费记录日期无效');
        if (entry.cost !== undefined) result.cost = v.number(entry.cost, '费用', 0, 1000000000);
        if (entry.currency !== undefined) result.currency = currencyCode(entry.currency);
        return result;
      }).slice(-50);
    } else if (key === "value")
      data[key] = v.number(value, "测量值", -1000000, 1000000);
    else if (key === "done") {
      if (typeof value !== "boolean") throw new Error("完成状态无效");
      data[key] = value;
    } else if (key === "stages") {
      data[key] = v.strings(value, 4);
      if (
        data[key].some(
          (s) => !["contact", "learned", "used", "produced"].includes(s),
        )
      )
        throw new Error("经历节点无效");
    } else data[key] = v.text(value, key, key === "practice" ? 10000 : 2000);
  }
  if (data.url) {
    const url = new URL(String(data.url));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("管理入口请使用 HTTP/HTTPS 地址");
  }
  if (
    data.cycle &&
    !["once", "monthly", "yearly", "other"].includes(String(data.cycle))
  )
    throw new Error("付费周期无效");
  if (
    input.kind === "measurement" &&
    (!data.metricId || typeof data.value !== "number" || !data.date)
  )
    throw new Error("请选择指标、日期并填写测量值");
  return {
    ...(input.id ? { id: v.text(input.id, "记录编号", 128) } : {}),
    kind: input.kind,
    name: v.name(input.name),
    body: v.text(input.body, "记录内容", 30000),
    data,
  };
}
export class PersonalLibrary {
  db: SqlDb;
  constructor(db: SqlDb) {
    this.db = db;
  }
  captureState(
    name: string,
    unit: string,
    value: number,
    date: string,
    metricId?: string,
  ): PersonalRecord {
    name = v.name(name);
    unit = v.text(unit, "单位", 50);
    const selected = metricId ? this.get(metricId) : null;
    if (metricId && (!selected || selected.kind !== 'metric' || selected.name !== name)) throw new Error('所选指标已变化，请重新选择');
    const existing = selected ? [selected] : this.list("metric").filter((m) => m.name === name);
    if (existing.length > 1) throw new Error("存在同名指标，请从已有指标选择");
    // Old/assistant records may omit an empty unit; keep their audit snapshots intact.
    if (existing[0] && String(existing[0].data.unit ?? '') !== unit)
      throw new Error("单位与已有指标不一致");
    return v.transaction(this.db, () => {
      const metric =
        existing[0] ||
        this.save({ kind: "metric", name, body: "", data: { unit } });
      return this.save({
        kind: "measurement",
        name: name + "记录",
        body: "",
        data: { metricId: metric.id, value, date },
      });
    });
  }
  private item(row: any): PersonalRecord {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      body: row.body,
      data: JSON.parse(row.data),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  list(kind?: PersonalKind): PersonalRecord[] {
    if (kind !== undefined && !PERSONAL_KINDS.includes(kind))
      throw new Error("个人记录类型无效");
    return (
      kind
        ? this.db
            .prepare(
              "SELECT * FROM personal_records WHERE kind=? ORDER BY updated_at DESC",
            )
            .all(kind)
        : this.db
            .prepare("SELECT * FROM personal_records ORDER BY updated_at DESC")
            .all()
    ).map((row) => this.item(row));
  }
  get(id: string): PersonalRecord | null {
    const row = this.db
      .prepare("SELECT * FROM personal_records WHERE id=?")
      .get(v.text(id, "记录编号", 128));
    return row ? this.item(row) : null;
  }
  renew(id: string, input: AssetRenewalInput): PersonalRecord {
    v.keys(input, ['to', 'cost', 'currency']);
    const record = this.get(id);
    if (!record || record.kind !== 'asset') throw new Error('背包记录不存在');
    const to = input.to === undefined ? renewalDate(record) : v.date(input.to);
    if (!to) throw new Error('请填写新的到期日');
    const data = { ...record.data }, renewal: AssetRenewal = { on: new Date().toLocaleDateString('sv-SE'), from: String(data.expiresOn || ''), to };
    if (input.cost !== undefined) {
      renewal.cost = v.number(input.cost, '费用', 0, 1000000000);
      data.cost = renewal.cost;
      if (input.currency !== undefined) data.currency = currencyCode(input.currency);
      if (data.currency) renewal.currency = String(data.currency);
    }
    data.expiresOn = to;
    data.renewals = [...(data.renewals || []), renewal];
    delete data.snoozedUntil;
    return this.save({ id, kind: 'asset', name: record.name, body: record.body, data });
  }
  snooze(id: string, until: string | null): PersonalRecord {
    const record = this.get(id);
    if (!record || record.kind !== 'asset') throw new Error('背包记录不存在');
    const data = { ...record.data };
    if (until === null) delete data.snoozedUntil;
    else {
      const date = v.date(until);
      if (date <= new Date().toLocaleDateString('sv-SE')) throw new Error('暂缓日期必须晚于今天');
      data.snoozedUntil = date;
    }
    return this.save({ id, kind: 'asset', name: record.name, body: record.body, data });
  }
  save(input: PersonalInput): PersonalRecord {
    const value = validatePersonal(input),
      now = Date.now(),
      id = value.id || (value.kind === "profile" ? "self" : randomUUID());
    const old = this.get(id);
    if (value.id && !old) throw new Error("个人记录不存在");
    if (old && old.kind !== value.kind) throw new Error("不能改变个人记录类型");
    if (old && value.kind === 'metric' && String(old.data.unit || '') !== String(value.data.unit || '') &&
      this.db.prepare("SELECT 1 FROM personal_records WHERE kind='measurement' AND json_extract(data,'$.metricId')=?").get(id)) {
      throw new Error('此指标已有历史记录，不能直接更改单位。请新建指标，以保留原数值的含义。');
    }
    if (
      value.kind === "measurement" &&
      this.get(String(value.data.metricId))?.kind !== "metric"
    )
      throw new Error("指标不存在");
    this.db
      .prepare(
        "INSERT INTO personal_records(id,kind,name,body,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body,data=excluded.data,updated_at=excluded.updated_at",
      )
      .run(
        id,
        value.kind,
        value.name,
        value.body,
        JSON.stringify(value.data),
        now,
        now,
      );
    return this.get(id)!;
  }
  remove(id: string): void {
    const item = this.get(id);
    if (!item) throw new Error("个人记录不存在");
    if (
      item.kind === "metric" &&
      this.db
        .prepare(
          "SELECT 1 FROM personal_records WHERE kind='measurement' AND json_extract(data,'$.metricId')=?",
        )
        .get(id)
    )
      throw new Error("请先移除此指标的测量记录");
    v.transaction(this.db, () => {
      if (item.kind === "skill")
        this.db
          .prepare("UPDATE skill_card SET parent_id='' WHERE parent_id=?")
          .run(id);
      this.db.prepare("DELETE FROM personal_records WHERE id=?").run(id);
    });
  }
}
