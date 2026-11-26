/** JSON 列不是数组或无法解析时，使用调用方提供的默认数组。 */
export function parseJsonArray<T = unknown>(raw: unknown, fallback: T[] = []): T[] {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback // 无效 JSON 使用默认数组。
  }
}
