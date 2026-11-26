import { createHash } from 'node:crypto'
import { getDb } from '../../services/storage/database.ts'
import { imagePageSource, readImagePage } from './files.ts'
import { imageThumbnail } from './thumbnails.ts'

const thumbnails = new Map<string, Buffer>()
let active = 0
const queue: Array<() => void> = []
export async function imageResponse(url: URL): Promise<Response> {
  const id = url.pathname.slice(1)
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not Found', { status: 404 })
  if (active >= 2) await new Promise<void>((resolve) => queue.push(resolve))
  else active++
  try {
    const respond = (data: Buffer, mime: string) => {
      imagePageSource(getDb(), id)
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' }
      })
    }
    // Always authorize before consulting the thumbnail cache, including after a group was hidden.
    const { data, mime } = await readImagePage(getDb(), id)
    if (url.searchParams.get('thumb') !== '1') return respond(data, mime)
    const key = id + ':' + createHash('sha256').update(data).digest('hex')
    let image = thumbnails.get(key)
    if (!image) {
      image = (await imageThumbnail(data)) ?? undefined
      if (!image) return respond(data, mime)
      thumbnails.set(key, image)
      while (thumbnails.size > 160) thumbnails.delete(thumbnails.keys().next().value!)
    }
    return respond(image, 'image/jpeg')
  } catch {
    return new Response('Image unavailable', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' }
    })
  } finally {
    const next = queue.shift()
    if (next) next()
    else active--
  }
}
