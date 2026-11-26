
import { tr } from "../i18n/index.ts"
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { workspace } from './workspace-api'

GlobalWorkerOptions.workerSrc = workerUrl

export class BaoyiPdfRangeTransport extends PDFDataRangeTransport {
  private documentId: string
  private read?: (offset: number, length: number) => Promise<Uint8Array>
  private stopped = false
  private queue = Promise.resolve()
  onFailure?: (error: Error) => void

  constructor(documentId: string, length: number, initialData?: Uint8Array, read?: (offset: number, length: number) => Promise<Uint8Array>) {
    super(length, initialData || new Uint8Array(0))
    this.documentId = documentId
    this.read = read
  }

  requestDataRange(begin: number, end: number): void {
    const length = Math.max(0, end - begin)
    if (length === 0) return
    this.queue = this.queue.then(async () => {
      if (this.stopped) return
      const chunks: Uint8Array[] = []
      for (let offset = begin; offset < end; offset += 1024 * 1024) {
        if (this.stopped) return
        const size = Math.min(1024 * 1024, end - offset)
        const chunk = await (this.read ? this.read(offset, size) : workspace.documents.pdfRange(this.documentId, offset, size))
        if (chunk.length !== size) throw new Error(tr('PDF 来源已变化或读取不完整，请重新打开'))
        chunks.push(chunk)
      }
      const result = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
      if (!this.stopped) this.onDataRange(begin, result)
    }).catch(error => { if (!this.stopped) this.onFailure?.(error); this.stopped = true })
  }
  abort() { this.stopped = true }
}

export function loadPdfDocument(source: Uint8Array | BaoyiPdfRangeTransport) {
  const base = new URL('pdfjs/', location.href.split('#')[0])
  const params: any = {
    cMapUrl: new URL('cmaps/', base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
    wasmUrl: new URL('wasm/', base).href,
  }
  if (source instanceof BaoyiPdfRangeTransport) {
    params.range = source
    params.rangeChunkSize = 65536
    params.disableAutoFetch = true
    params.disableStream = true
  } else {
    params.data = source.slice()
  }
  const task = getDocument(params)
  const failed = new Promise<never>((_, reject) => {
    if (source instanceof BaoyiPdfRangeTransport) source.onFailure = error => { reject(error); void task.destroy() }
  })
  return { promise: Promise.race([task.promise, failed]), destroy: () => task.destroy() }
}
