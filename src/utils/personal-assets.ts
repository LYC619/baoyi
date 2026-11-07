import type { PersonalRecord } from "../types/workspace.ts";
import { daysUntil } from './personal-view.ts'

export function annualCost(record: PersonalRecord): number | null {
  const {cost,cycle}=record.data
  return typeof cost === 'number' && Number.isFinite(cost) && ['monthly','yearly'].includes(String(cycle)) ? cost * (cycle === 'monthly' ? 12 : 1) : null
}

export function matchesExpiry(record: PersonalRecord, status: string, today: string, remindDays: number) {
  const days=daysUntil(record.data.expiresOn,today)
  return status === 'overdue' ? days !== null && days < 0 : status === 'soon' ? days !== null && days >= 0 && days <= remindDays : status === 'undated' ? days === null : true
}

export function assetAnnualCosts(records: PersonalRecord[]) {
  const totals: Record<string, number> = {};
  let omitted = 0;
  for (const record of records) {
    const { cost, currency, cycle } = record.data;
    if (cycle === "once") continue;
    if (
      typeof cost !== "number" ||
      !currency ||
      !["monthly", "yearly"].includes(String(cycle))
    ) {
      omitted++;
      continue;
    }
    totals[String(currency)] =
      (totals[String(currency)] || 0) + cost * (cycle === "monthly" ? 12 : 1);
  }
  return { totals, omitted };
}

export function filterAssets(
  records: PersonalRecord[],
  query: string,
  category: string,
  sort: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  return records
    .filter(
      (r) =>
        (!category || (r.data.category || '其他') === category) &&
        [r.name, r.body, r.data.provider, r.data.category]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh-CN")
        : sort === "cost"
          ? String(a.data.currency || "").localeCompare(
              String(b.data.currency || ""),
            ) || (annualCost(b) ?? -1) - (annualCost(a) ?? -1) || a.name.localeCompare(b.name, 'zh-CN')
          : String(a.data.expiresOn || "9999").localeCompare(
              String(b.data.expiresOn || "9999"),
            ) || a.name.localeCompare(b.name),
    );
}
