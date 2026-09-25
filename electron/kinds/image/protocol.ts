import { nativeImage } from 'electron'
import { getDb } from '../../services/database.ts'
import { readImagePage } from './files.ts'

const thumbnails = new Map<string, Buffer>()
let active = 0
const queue: Array<() => void> = []
export async function imageResponse(url: URL): Promise<Response> {
  const id = url.pathname.slice(1)
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not Found', { status: 404 })
  if (active >= 2) await new Promise<void>(resolve => queue.push(resolve))
  else active++
  try {
    // Always authorize before consulting the thumbnail cache, including after a group was hidden.
    const { data, mime } = await readImagePage(getDb(), id)
    if (url.searchParams.get('thumb') !== '1') return new Response(new Uint8Array(data), { headers: { 'Content-Type': mime, 'Cache-Control':'no-store' } })
    const key = id + ':' + data.length + ':' + data.subarray(0,64).toString('hex')
    let image = thumbnails.get(key)
    if (!image) {
      const decoded = nativeImage.createFromBuffer(data)
      if (decoded.isEmpty()) throw new Error('无法解码图片')
      const size = decoded.getSize()
      const ratio = Math.min(1, 440 / Math.max(size.width, size.height))
      image = decoded.resize({ width: Math.max(1, Math.round(size.width*ratio)), height: Math.max(1, Math.round(size.height*ratio)), quality: 'good' }).toJPEG(82)
      thumbnails.set(key, image)
      while (thumbnails.size > 160) thumbnails.delete(thumbnails.keys().next().value!)
    }
    return new Response(new Uint8Array(image), { headers: { 'Content-Type':'image/jpeg', 'Cache-Control':'no-store' } })
  } catch { return new Response('Image unavailable', { status: 404 }) }
  finally { const next = queue.shift(); if (next) next(); else active-- }
}
