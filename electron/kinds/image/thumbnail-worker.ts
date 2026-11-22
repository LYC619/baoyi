import { parentPort } from 'node:worker_threads'
import { createCanvas, loadImage } from '@napi-rs/canvas'

parentPort!.on('message', async (data: Uint8Array) => {
  try {
    const image = await loadImage(Buffer.from(data))
    const ratio = Math.min(1, 440 / Math.max(image.width, image.height))
    const canvas = createCanvas(
      Math.max(1, Math.round(image.width * ratio)),
      Math.max(1, Math.round(image.height * ratio))
    )
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    const bytes = Uint8Array.from(await canvas.encode('jpeg', 82))
    parentPort!.postMessage(bytes, [bytes.buffer])
  } catch {
    // Unsupported raster formats can still be decoded by Chromium in the renderer.
    parentPort!.postMessage(null)
  }
})
