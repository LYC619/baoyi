
import { tr } from '../i18n/core.ts'

import { currentLocale as appLocale } from '../i18n/core.ts'
import type { PersonalRecord } from "../types/workspace.ts";
import { daysUntil } from './personal-view.ts'

export const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  JPY: 'JP¥',
  HKD: 'HK$',
}

export function formatAssetPrice(cost: unknown, currency: unknown): string {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return tr('费用未填写')
  const code = String(currency || '').trim().toUpperCase()
  const sym = CURRENCY_SYMBOLS[code]
  const num = cost.toLocaleString(appLocale.value, { maximumFractionDigits: 2 })
  if (sym && code) return `${sym}${num} ${code}`
  return code ? `${num} ${code}` : num
}

export function renewalDate(record: PersonalRecord): string {
  const { expiresOn, cycle } = record.data
  if (!expiresOn || !['monthly', 'yearly'].includes(String(cycle))) return ''
  const date = new Date(String(expiresOn) + 'T00:00:00Z'), day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + (cycle === 'monthly' ? 1 : 12))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, end))
  return date.toISOString().slice(0, 10)
}

export function isSnoozed(record: PersonalRecord, today: string): boolean {
  return typeof record.data.snoozedUntil === 'string' && record.data.snoozedUntil > today
}

export function isReminding(record: PersonalRecord, remindDays: number, today: string): boolean {
  const days = daysUntil(record.data.expiresOn, today)
  return days !== null && days <= remindDays && !isSnoozed(record, today)
}

export function annualCost(record: PersonalRecord): number | null {
  const { cost, cycle } = record.data
  return typeof cost === 'number' && Number.isFinite(cost) && ['monthly', 'yearly'].includes(String(cycle))
    ? cost * (cycle === 'monthly' ? 12 : 1)
    : null
}

export function matchesExpiry(record: PersonalRecord, status: string, today: string, remindDays: number) {
  const days = daysUntil(record.data.expiresOn, today)
  if (status === 'reminding') return isReminding(record, remindDays, today)
  if (status === 'snoozed') return isSnoozed(record, today)
  return status === 'overdue'
    ? isReminding(record, remindDays, today) && days! < 0
    : status === 'soon'
      ? isReminding(record, remindDays, today) && days! >= 0
      : status === 'undated'
        ? days === null
        : true
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
