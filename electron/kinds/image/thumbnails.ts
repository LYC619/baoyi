import { Worker } from 'node:worker_threads'

type Pending = { resolve: (value: Buffer | null) => void; reject: (error: Error) => void }
const slots = new Set<ThumbnailWorker>()

class ThumbnailWorker {
  private worker: Worker
  private pending?: Pending
  private timer?: ReturnType<typeof setTimeout>
  private closing?: Promise<number>
  get busy() {
    return !!this.pending
  }

  constructor() {
    const filename = import.meta.url.endsWith('.ts')
      ? './thumbnail-worker.ts'
      : './image-thumbnail-worker.js'
    this.worker = new Worker(new URL(filename, import.meta.url))
    this.worker.on('message', (bytes: Uint8Array | null) => {
      const pending = this.pending
      this.pending = undefined
      clearTimeout(this.timer)
      this.worker.unref()
      this.timer = setTimeout(() => {
        void this.close()
      }, 30000)
      this.timer.unref()
      pending?.resolve(bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.fail(new Error(`图片缩略图处理已退出（${code}）`)))
  }

  render(data: Buffer): Promise<Buffer | null> {
    clearTimeout(this.timer)
    this.worker.ref()
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.timer = setTimeout(() => this.fail(new Error('图片缩略图处理超时')), 30000)
      const bytes = Uint8Array.from(data)
      this.worker.postMessage(bytes, [bytes.buffer])
    })
  }

  private fail(error: Error) {
    const pending = this.pending
    this.pending = undefined
    pending?.reject(error)
    void this.close()
  }

  close(): Promise<number> {
    clearTimeout(this.timer)
    slots.delete(this)
    return (this.closing ??= this.worker.terminate())
  }
}

/** The image protocol admits at most two requests; reuse one decoder per active request. */
export function imageThumbnail(data: Buffer): Promise<Buffer | null> {
  let slot = [...slots].find((slot) => !slot.busy)
  if (!slot) {
    slot = new ThumbnailWorker()
    slots.add(slot)
  }
  return slot.render(data)
}

export async function closeImageThumbnails() {
  await Promise.all([...slots].map((slot) => slot.close()))
}
