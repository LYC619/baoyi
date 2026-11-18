export interface LyricLine { time: number | null; text: string }
export interface AudioLyrics { status: 'available' | 'none' | 'unavailable'; source: string; lines: LyricLine[]; timed: boolean; message: string }

/** LRC timestamps can repeat on one line; equal times often carry translations. */
export function parseLyrics(text: string): Pick<AudioLyrics, 'lines' | 'timed'> {
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const rawOffset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0
  const timed: LyricLine[] = [], plain: LyricLine[] = []
  for (const row of rows) {
    const stamps = [...row.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)]
    const content = row.replace(/\[(?:\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?|(?:ar|al|ti|by|offset|length|re|ve):[^\]]*)\]/gi, '').trim()
    if (!content) continue
    if (!stamps.length) plain.push({time:null,text:content})
    for (const stamp of stamps) timed.push({time:Math.max(0, Number(stamp[1])*60+Number(stamp[2])+Number('0.'+(stamp[3]||'0'))+offset),text:content})
  }
  if (!timed.length) return {lines:plain,timed:false}
  const merged: LyricLine[] = []
  for (const line of timed.sort((a,b)=>a.time!-b.time!)) {
    const previous=merged.at(-1)
    if(previous?.time===line.time) { if(!previous.text.split('\n').includes(line.text))previous.text+='\n'+line.text }
    else merged.push({...line})
  }
  return {lines:merged,timed:true}
}

export function activeLyricIndex(lines: LyricLine[], seconds: number): number {
  let low=0,high=lines.length-1,result=-1
  while(low<=high){const mid=(low+high)>>1,time=lines[mid].time;if(time!==null&&time<=seconds){result=mid;low=mid+1}else high=mid-1}
  return result
}
