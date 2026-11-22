import { randomUUID, createHash } from "node:crypto";
import type { SqlDb } from "../services/storage/schema.ts";
import { PersonalLibrary } from "./personal.ts";
import type {
  SkillCard,
  SkillDraft,
  SkillProposal,
  SkillRecord,
  SkillRecordInput,
} from "../../src/types/skill-profile.ts";
import * as v from "./validation.ts";

export const SKILL_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS skill_card(id TEXT PRIMARY KEY REFERENCES personal_records(id) ON DELETE CASCADE,parent_id TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS skill_metric(id TEXT PRIMARY KEY,card_id TEXT NOT NULL REFERENCES skill_card(id) ON DELETE CASCADE,metric_key TEXT NOT NULL,label TEXT NOT NULL,unit TEXT NOT NULL,value_type TEXT NOT NULL CHECK(value_type IN ('number','text','date')),version INTEGER NOT NULL DEFAULT 1,UNIQUE(card_id,metric_key,version));
CREATE TABLE IF NOT EXISTS skill_record(id TEXT PRIMARY KEY,card_id TEXT NOT NULL REFERENCES skill_card(id) ON DELETE CASCADE,metric_id TEXT NOT NULL REFERENCES skill_metric(id) ON DELETE CASCADE,version INTEGER NOT NULL,value_json TEXT NOT NULL,occurred_on TEXT NOT NULL,evidence TEXT NOT NULL,request_id TEXT NOT NULL,undone INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(card_id,request_id));
CREATE TABLE IF NOT EXISTS skill_proposal(id TEXT PRIMARY KEY,draft_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('proposed','applied','cancelled')),card_id TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO skill_card(id) SELECT id FROM personal_records WHERE kind='skill';
`;

export function validateSkillDraft(input: SkillDraft): SkillDraft {
  v.keys(input, [
    "name",
    "summary",
    "parentId",
    "metrics",
    "cardId",
    "sourceStamp",
  ]);
  if (
    !Array.isArray(input.metrics) ||
    !input.metrics.length ||
    input.metrics.length > 12
  )
    throw new Error("请提供 1–12 个指标");
  const keys = new Set<string>();
  const metrics = input.metrics.map((m) => {
    v.keys(m, ["key", "label", "unit", "type"]);
    const key = v.name(m.key);
    if (keys.has(key)) throw new Error("指标标识不能重复");
    keys.add(key);
    if (!["number", "text", "date"].includes(m.type))
      throw new Error("指标类型无效");
    return {
      key,
      label: v.name(m.label),
      unit: v.text(m.unit, "单位", 50),
      type: m.type,
    };
  });
  return {
    ...(input.cardId ? { cardId: v.text(input.cardId, "技能编号", 128) } : {}),
    ...(input.sourceStamp
      ? { sourceStamp: v.text(input.sourceStamp, "草案版本", 128) }
      : {}),
    name: v.name(input.name),
    summary: v.text(input.summary, "事实摘要", 10000),
    parentId: v.text(input.parentId || "", "父技能", 128),
    metrics,
  };
}

export class SkillProfiles {
  db: SqlDb;
  constructor(db: SqlDb) {
    this.db = db;
  }
  private existingDraft(cardId: string) {
    const item = new PersonalLibrary(this.db).get(cardId);
    if (!item || item.kind !== "skill") throw new Error("技能不存在");
    const metrics = this.db
      .prepare(
        "SELECT * FROM skill_metric WHERE card_id=? ORDER BY metric_key,version",
      )
      .all(cardId);
    return {
      item,
      stamp: createHash("sha256")
        .update(JSON.stringify({ item, metrics }))
        .digest("hex"),
    };
  }
  list(): SkillCard[] {
    return (
      this.db
        .prepare(
          "SELECT p.*,c.parent_id FROM personal_records p LEFT JOIN skill_card c ON c.id=p.id WHERE p.kind='skill' ORDER BY p.updated_at DESC",
        )
        .all() as any[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      summary:
        row.body ||
        [JSON.parse(row.data).practice, JSON.parse(row.data).level]
          .filter(Boolean)
          .join("\n"),
      parentId: row.parent_id || "",
      metrics: (
        this.db
          .prepare("SELECT * FROM skill_metric WHERE card_id=? ORDER BY rowid")
          .all(row.id) as any[]
      ).map((m) => ({
        key: m.metric_key,
        label: m.label,
        unit: m.unit,
        type: m.value_type,
        version: m.version,
      })),
      records: (
        this.db
          .prepare(
            "SELECT r.*,m.metric_key FROM skill_record r JOIN skill_metric m ON m.id=r.metric_id WHERE r.card_id=? AND r.undone=0 ORDER BY r.occurred_on,r.created_at",
          )
          .all(row.id) as any[]
      ).map((r) => ({
        id: r.id,
        cardId: r.card_id,
        metricKey: r.metric_key,
        version: r.version,
        value: JSON.parse(r.value_json),
        date: r.occurred_on,
        evidence: r.evidence,
      })),
    }));
  }
  proposals(): SkillProposal[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM skill_proposal WHERE state='proposed' ORDER BY created_at",
        )
        .all() as any[]
    ).map((r) => ({
      id: r.id,
      draft: JSON.parse(r.draft_json),
      state: r.state,
      cardId: r.card_id,
    }));
  }
  propose(input: SkillDraft): SkillProposal {
    const draft = validateSkillDraft(input);
    if (draft.cardId)
      draft.sourceStamp = this.existingDraft(draft.cardId).stamp;
    if (draft.parentId && !this.list().some((c) => c.id === draft.parentId))
      throw new Error("父技能不存在");
    const existing = this.proposals().find(
      (p) => JSON.stringify(p.draft) === JSON.stringify(draft),
    );
    if (existing) return existing;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO skill_proposal(id,draft_json,state,created_at) VALUES(?,?,'proposed',?)",
      )
      .run(id, JSON.stringify(draft), Date.now());
    return { id, draft, state: "proposed", cardId: "" };
  }
  confirm(id: string, edited?: SkillDraft): SkillCard {
    const row = this.db
      .prepare("SELECT * FROM skill_proposal WHERE id=?")
      .get(v.text(id, "草案编号", 128)) as any;
    if (!row || row.state === "cancelled")
      throw new Error("草案不存在或已取消");
    if (row.state === "applied") {
      const card = this.list().find((c) => c.id === row.card_id);
      if (!card) throw new Error("已确认的卡片已删除");
      return card;
    }
    const original = JSON.parse(row.draft_json);
    const draft = validateSkillDraft({
      ...(edited || original),
      cardId: original.cardId,
      sourceStamp: original.sourceStamp,
    });
    const previous = draft.cardId ? this.existingDraft(draft.cardId) : null;
    if (previous && previous.stamp !== draft.sourceStamp)
      throw new Error("技能已有人工修改，此草案已过期，请重新生成");
    if (
      this.list().some(
        (c) =>
          c.id !== draft.cardId &&
          c.name.toLocaleLowerCase() === draft.name.toLocaleLowerCase(),
      )
    )
      throw new Error("已有同名技能，请在已有卡片追加记录");
    if (draft.parentId && !this.list().some((c) => c.id === draft.parentId))
      throw new Error("父技能不存在");
    let parent = draft.parentId;
    const visited = new Set<string>();
    while (parent) {
      if (parent === draft.cardId || visited.has(parent))
        throw new Error("技能层级不能形成循环");
      visited.add(parent);
      parent = this.list().find((c) => c.id === parent)?.parentId;
    }
    return v.transaction(this.db, () => {
      const card = new PersonalLibrary(this.db).save({
        ...(previous ? { id: previous.item.id } : {}),
        kind: "skill",
        name: draft.name,
        body: draft.summary,
        data: previous?.item.data || {},
      });
      this.db
        .prepare(
          "INSERT INTO skill_card(id,parent_id) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,revision=revision+1",
        )
        .run(card.id, draft.parentId || "");
      for (const m of draft.metrics) {
        const prior = this.db
          .prepare(
            "SELECT * FROM skill_metric WHERE card_id=? AND metric_key=? ORDER BY version DESC LIMIT 1",
          )
          .get(card.id, m.key) as any;
        if (
          prior &&
          prior.label === m.label &&
          prior.unit === m.unit &&
          prior.value_type === m.type
        )
          continue;
        this.db
          .prepare(
            "INSERT INTO skill_metric(id,card_id,metric_key,label,unit,value_type,version) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            card.id,
            m.key,
            m.label,
            m.unit,
            m.type,
            (prior?.version || 0) + 1,
          );
      }
      this.db
        .prepare(
          "UPDATE skill_proposal SET state='applied',card_id=?,draft_json=? WHERE id=?",
        )
        .run(card.id, JSON.stringify(draft), id);
      return this.list().find((c) => c.id === card.id)!;
    });
  }
  cancel(id: string) {
    this.db
      .prepare(
        "UPDATE skill_proposal SET state='cancelled' WHERE id=? AND state='proposed'",
      )
      .run(v.text(id, "草案编号", 128));
  }
  record(input: SkillRecordInput): SkillRecord {
    v.keys(input, [
      "cardId",
      "metricKey",
      "version",
      "value",
      "date",
      "requestId",
      "evidence",
    ]);
    const cardId = v.text(input.cardId, "技能编号", 128),
      key = v.name(input.metricKey),
      requestId = v.text(input.requestId, "请求编号", 128);
    if (!requestId) throw new Error("缺少请求编号");
    const metric = this.db
      .prepare(
        "SELECT * FROM skill_metric WHERE card_id=? AND metric_key=? AND version=?",
      )
      .get(cardId, key, input.version) as any;
    if (!metric || metric.version !== input.version)
      throw new Error("指标不存在或口径版本已变化");
    const value =
      metric.value_type === "number"
        ? v.number(input.value, "指标数值", -1e12, 1e12)
        : metric.value_type === "date"
          ? v.date(input.value)
          : v.text(input.value, "记录值", 4000);
    const date = v.date(input.date);
    if (!date) throw new Error("请提供记录日期");
    const evidence = v.text(input.evidence, "事实来源", 4000);
    const existing = this.db
      .prepare("SELECT * FROM skill_record WHERE card_id=? AND request_id=?")
      .get(cardId, requestId) as any;
    if (existing) {
      if (existing.undone) throw new Error("这条记录已撤销，重试不会重新登记");
      if (
        existing.metric_id !== metric.id ||
        existing.value_json !== JSON.stringify(value) ||
        existing.occurred_on !== date ||
        existing.evidence !== evidence
      )
        throw new Error("请求编号已用于不同记录");
      return {
        id: existing.id,
        cardId,
        metricKey: key,
        version: metric.version,
        value,
        date,
        evidence,
      };
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO skill_record(id,card_id,metric_id,version,value_json,occurred_on,evidence,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        cardId,
        metric.id,
        metric.version,
        JSON.stringify(value),
        date,
        evidence,
        requestId,
        Date.now(),
      );
    return {
      id,
      cardId,
      metricKey: key,
      version: metric.version,
      value,
      date,
      evidence,
    };
  }
  undoRecord(id: string) {
    this.db
      .prepare("UPDATE skill_record SET undone=1 WHERE id=?")
      .run(v.text(id, "记录编号", 128));
  }
}
