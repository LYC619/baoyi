export interface SkillMetric {
  key: string;
  label: string;
  unit: string;
  type: "number" | "text" | "date";
  version: number;
}
export interface SkillDraft {
  cardId?: string;
  sourceStamp?: string;
  name: string;
  summary: string;
  parentId?: string;
  metrics: Omit<SkillMetric, "version">[];
}
export interface SkillProposal {
  id: string;
  draft: SkillDraft;
  state: "proposed" | "applied" | "cancelled";
  cardId: string;
}
export interface SkillRecord {
  id: string;
  cardId: string;
  metricKey: string;
  version: number;
  value: string | number;
  date: string;
  evidence: string;
}
export interface SkillCard {
  id: string;
  name: string;
  summary: string;
  parentId: string;
  metrics: SkillMetric[];
  records: SkillRecord[];
}
export interface SkillRecordInput {
  cardId: string;
  metricKey: string;
  version: number;
  value: string | number;
  date: string;
  requestId: string;
  evidence: string;
}
export interface SkillApi {
  list(): Promise<SkillCard[]>;
  proposals(): Promise<SkillProposal[]>;
  save(draft: SkillDraft): Promise<SkillCard>;
  record(input: SkillRecordInput): Promise<SkillRecord>;
  confirm(id: string, draft?: SkillDraft): Promise<SkillCard>;
  cancel(id: string): Promise<void>;
  undoRecord(id: string): Promise<void>;
}
