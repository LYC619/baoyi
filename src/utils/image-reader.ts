type Page = { chapterId: string | null }
type Size = { width: number; height: number }

export function imageSpread(pages: Page[], index: number, coverSingle: boolean): { start: number; length: number } {
  if (!pages.length) return { start: 0, length: 0 }
  const at = Math.max(0, Math.min(pages.length - 1, Math.trunc(index)))
  if (at === 0 && coverSingle) return { start: 0, length: 1 }
  let chapterStart = at
  while (chapterStart > 0 && pages[chapterStart - 1].chapterId === pages[at].chapterId) chapterStart--
  const base = chapterStart === 0 && coverSingle ? 1 : chapterStart
  const start = base + Math.floor((at - base) / 2) * 2
  return { start, length: pages[start + 1]?.chapterId === pages[start].chapterId ? 2 : 1 }
}

export function imageCanvasLayout(images: Size[], viewport: Size, fit: 'screen' | 'width' | 'original', rotation: number) {
  const gap = images.length > 1 ? 8 : 0, turned = Math.abs(rotation) % 180 === 90
  const available = Math.max(1, viewport.width - gap * (images.length - 1)) / Math.max(1, images.length)
  const sheets = images.map(image => {
    const width = turned ? image.height : image.width, height = turned ? image.width : image.height
    const scale = fit === 'original' ? 1 : fit === 'width' ? available / width : Math.min(1, available / width, Math.max(1, viewport.height) / height)
    return { width: width * scale, height: height * scale, imageWidth: image.width * scale, imageHeight: image.height * scale }
  })
  return { sheets, width: sheets.reduce((sum, sheet) => sum + sheet.width, 0) + gap * Math.max(0, images.length - 1), height: Math.max(0, ...sheets.map(sheet => sheet.height)) }
}
