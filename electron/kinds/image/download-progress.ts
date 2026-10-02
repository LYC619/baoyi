import type { ImageDownloadProgress } from '../../../src/types/image.ts'

export function normalizeDownloadProgress(value?: Partial<ImageDownloadProgress>): ImageDownloadProgress {
  const phases: ImageDownloadProgress['phase'][] = ['queued', 'catalog', 'checking', 'connecting', 'receiving', 'retrying', 'rate-limited', 'saving', 'importing', 'idle']
  const count = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : 0
  return {
    phase: phases.includes(value?.phase as ImageDownloadProgress['phase']) ? value!.phase! : 'queued',
    totalKnown: value?.totalKnown === true,
    catalogChapters: count(value?.catalogChapters), chapterIndex: count(value?.chapterIndex),
    chapterProcessed: count(value?.chapterProcessed), chapterTotal: count(value?.chapterTotal),
    reusedPages: count(value?.reusedPages), storedBytes: count(value?.storedBytes),
    receivedBytes: count(value?.receivedBytes), bytesPerSecond: count(value?.bytesPerSecond), retryAt: count(value?.retryAt),
    effectiveConcurrency: count(value?.effectiveConcurrency),
  }
}

export function createTransferMeter(now: () => number = Date.now) {
  const started = now(), windowMs = 3000
  const buckets: Array<{ at: number; bytes: number }> = []
  function prune(time: number) { while (buckets.length && buckets[0].at <= time - windowMs) buckets.shift() }
  return {
    add(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid transfer byte count')
      const time = now(), at = Math.floor(time / 250) * 250
      prune(time)
      const last = buckets.at(-1)
      if (last?.at === at) last.bytes += bytes
      else buckets.push({ at, bytes })
    },
    speed() {
      const time = now(), elapsed = Math.min(windowMs, time - started)
      prune(time)
      return elapsed < 250 ? 0 : Math.round(buckets.reduce((sum, bucket) => sum + bucket.bytes, 0) * 1000 / elapsed)
    },
  }
}
