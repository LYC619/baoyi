const clean = (value: string) => value.normalize('NFKC').replace(/\.(mp4|mkv|avi|mov|webm|m4v)$/i, '')
  .replace(/(?:\s*[\[（(](?:中文字幕|中文(?:简体|繁体)?字幕|中字|字幕|chs|cht|subbed|\d{3,4}p)[\]）)]|[ ._-]+\d{3,4}p)+$/gi, '').trim()
export const seriesKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s._·・-]+/g, ' ').trim()
function number(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 }
  if (value.includes('十')) { const [left, right] = value.split('十'); return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0) }
  return digits[value] ?? NaN
}
export function seriesPart(value: string): { title: string; number: number; season: number } | null {
  const text = clean(value)
  if (/\d+\s*[-~–—～]\s*\d+$/.test(text)) return null
  const seasonal = /^(.*?)\s*[ ._-]*S(\d{1,2})E(\d{1,3})\s*$/i.exec(text)
  if (seasonal?.[1].trim()) return { title: seasonal[1].trim(), season: Number(seasonal[2]), number: Number(seasonal[3]) }
  const marked = /^(.*?)(?:\s*第\s*|[ ._-]+(?:EP?(?:ISODE)?|VOL(?:UME)?|PART|LEVEL|CHAPTER)[ .:_-]*|\s*#\s*)(\d{1,3}|[零〇一二三四五六七八九十两]{1,3})\s*(?:集|話|话|章)?(?:\s*[-—:：「].*)?$/i.exec(text)
  const plain = marked || /^(.*?[^\d])(?:\s*)(\d{1,3})$/.exec(text)
  if (!plain || !plain[1].trim()) return null
  const title = plain[1].replace(/[ ._-]+$/, '').trim(), n = number(plain[2])
  if (!title || !Number.isInteger(n) || /^(?:part|episode|ep|chapter|vol|level|第|集)$/i.test(title)) return null
  return { title, number: n, season: 0 }
}
export function collectionName(names: string[], numbers: number[] = []): string {
  const titles = names.map(clean).filter(Boolean)
  if (!titles.length) return ''
  const parts = titles.map(seriesPart), first = parts.find(Boolean)
  const same = first && titles.every((title, i) => seriesKey(parts[i]?.title || title) === seriesKey(first.title))
  let base = same ? first.title : titles[0].replace(/\s+\d+\s*[-~–—～]\s*\d+$/, '')
  if (!same && titles.length > 1 && !titles.every(title => seriesKey(title) === seriesKey(base))) {
    let prefix = titles[0]
    for (const title of titles.slice(1)) { while (prefix && !title.startsWith(prefix)) prefix = prefix.slice(0, -1) }
    prefix = prefix.replace(/[\s._-]+$/, '')
    base = prefix.length >= 3 ? prefix : '所选作品'
  }
  const known = [...new Set((numbers.length ? numbers : same ? parts.filter(Boolean).map(part => part!.number) : []).filter(n => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b)
  if (known.length > 1) return `${base} ${known[0]}-${known[known.length - 1]}`
  return titles.length > 1 ? `${base}（${titles.length} 集）` : base
}
