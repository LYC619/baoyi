import { imageSize } from 'image-size'
import type { ImagePageInfo } from '../../../src/types/image.ts'
import { imageMime } from './files.ts'

export function inspectImage(data: Uint8Array): ImagePageInfo {
  const mime = imageMime(data), dimensions = imageSize(data)
  const { width, height } = dimensions
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 100000000) throw new Error('图片尺寸无效或像素数过大')
  return { width, height, format: mime.slice(6).toUpperCase(), size: data.byteLength }
}
