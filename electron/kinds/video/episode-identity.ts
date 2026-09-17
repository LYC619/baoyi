/** Names are presentation; only a consistent catalogue may establish series membership. */
export function cleanEpisodeTitle(value: string): string {
  return String(value || '').replace(/\.(?:mp4|mkv|avi|mov|m4v|webm|wmv)$/i, '')
    .replace(/[ _.-]*[\[（(]?(?:2160|1080|720|480|360)[pP][\]）)]?$/g, '').trim()
}

export function numberedEpisode(value: string): { title: string; number: number; season?: number } | null {
  const text = cleanEpisodeTitle(value).normalize('NFKC').replace(/\s*\[(?:中文字幕|中字|字幕|sub(?:bed)?|chs|cht)\]\s*$/i, '').trim()
  if (/\d+\s*[-~–—～]\s*\d+$/.test(text)) return null
  const seasonal = /^(.*?)\s*[ ._-]*[sS](\d{1,2})[eE](\d{1,3})[ ._-]*$/.exec(text)
  if (seasonal?.[1].trim()) return { title: seasonal[1].trim(), number: Number(seasonal[3]), season: Number(seasonal[2]) }
  // E/EP needs a boundary: the final e in a word such as "Example" is not an episode marker.
  const explicit = /^(.*?)(?:[ ._-]+(?:e(?:p(?:isode)?)?)[ ._-]*|\s*第\s*)(\d{1,3}|零|〇)\s*(?:集|話|话)?[ ._-]*$/i.exec(text)
  if (explicit?.[1].trim()) return { title: explicit[1].trim(), number: /^(零|〇)$/.test(explicit[2]) ? 0 : Number(explicit[2]) }
  const prologue = /^(.*?)[・· ._-]+(?:零|〇)(?:\s*[-—–:：].*)?$/.exec(text)
  if (prologue?.[1].trim()) return { title: prologue[1].trim(), number: 0 }
  const numbered = /^(.*?[^\d])\s*(\d{1,3})$/.exec(text)
  if (!numbered || !numbered[1].trim()) return null
  return { title: numbered[1].replace(/[ ._-]+$/, '').trim(), number: Number(numbered[2]) }
}

export function catalogueIdentity<T extends { videoCode: string; title: string }>(title: string, entries: T[]): { title: string; episodes: Array<T & { order: number; numbered: boolean }> } {
  const parsed = entries.map(entry => numberedEpisode(entry.title))
  const names = new Map<string, Set<number>>()
  for (const part of parsed) if (part?.title) {
    const key = part.title.normalize('NFKC').toLowerCase()
    const numbers = names.get(key) || new Set<number>(); numbers.add(part.number); names.set(key, numbers)
  }
  const consistent = [...names.entries()].filter(([base, numbers]) => numbers.size >= 2 && !/^(?:part|episode|ep|chapter|lesson|第|集|章节|章節)$/i.test(base)).sort((a, b) => b[1].size - a[1].size)[0]
  const base = consistent ? parsed.find(part => part?.title.normalize('NFKC').toLowerCase() === consistent[0])!.title : title
  // A source may name its playlist in Japanese and the episodes in Chinese.
  const workTitle = consistent ? base : title
  const episodes = entries.map((entry, index) => {
    const part = parsed[index]
    const first = !!consistent && !consistent[1].has(1) && cleanEpisodeTitle(entry.title).normalize('NFKC').toLowerCase() === consistent[0]
    const prequel = !!part && part.number === 0 && !!consistent && consistent[0].startsWith(part.title.normalize('NFKC').toLowerCase() + '・')
    const numbered = first || prequel || !!part && (!!consistent ? part.title.normalize('NFKC').toLowerCase() === consistent[0] : part.title === title)
    return { ...entry, order: first ? 1 : numbered ? part!.number : index + 1, numbered }
  }).sort((a, b) => a.order - b.order)
  return { title: workTitle || '未命名作品', episodes }
}

export function episodeFilename(originalTitle: string, number: number, quality: string, extension: string): string {
  if (!/^(mp4|mkv|m4v|mov|webm|avi|ogv|ogg|mpg|mpeg)$/i.test(extension)) throw new Error('视频扩展名无效')
  const safe = (value: string) => value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  let title = safe(cleanEpisodeTitle(originalTitle)).slice(0, 130).replace(/[. ]+$/, '') || '未命名内容'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = '_' + title
  return `${title} - E${String(Math.max(0, Math.round(number))).padStart(2, '0')} ${safe(quality).slice(0, 20) || '原始画质'}.${extension.toLowerCase()}`
}

export function collectionRangeTitle(title: string, numbers: number[]): string {
  const known = [...new Set(numbers.filter(value => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b)
  const base = title.replace(/\s+\d+\s*[-~–—～]\s*\d+$/, '').trim()
  return known.length > 1 ? `${base} ${known[0]}-${known[known.length - 1]}` : title
}
