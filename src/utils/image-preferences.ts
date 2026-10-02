import type { ImagePreferences } from '../types/image.ts'

export const DEFAULT_IMAGE_PREFERENCES: Readonly<Required<ImagePreferences>> = Object.freeze({ mode: 'single', direction: 'ltr', fit: 'screen', coverSingle: true, zoom: 1 })
export function normalizeImagePreferences(value: unknown): Required<ImagePreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('阅读设置无效')
  const p = value as ImagePreferences
  if (!['single', 'double', 'scroll'].includes(p.mode) || !['ltr', 'rtl'].includes(p.direction) || !['screen', 'width', 'original'].includes(p.fit) || (p.coverSingle !== undefined && typeof p.coverSingle !== 'boolean')) throw new Error('阅读设置无效')
  const zoom = p.zoom === undefined ? 1 : p.zoom
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0.25 || zoom > 4) throw new Error('图片缩放必须在 25% 到 400% 之间')
  return { mode: p.mode, direction: p.direction, fit: p.fit, coverSingle: p.coverSingle ?? true, zoom }
}
