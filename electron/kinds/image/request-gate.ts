type Waiting = { start: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; abort: () => void }

export function createImageRequestGate(capacity: () => number, changed: () => void = () => {}) {
  const waiting: Waiting[] = []
  let active = 0, limited = false, until = 0, closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const concurrency = () => limited ? 1 : Math.max(1, Math.min(3, capacity()))
  function drain() {
    clearTimeout(timer); timer = undefined
    if (closed || !waiting.length) return
    if (Date.now() < until) { timer = setTimeout(drain, until - Date.now()); return }
    while (waiting.length && active < concurrency()) {
      const item = waiting.shift()!
      item.signal?.removeEventListener('abort', item.abort)
      if (item.signal?.aborted) item.reject(item.signal.reason)
      else item.start()
    }
  }
  return {
    run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (closed) return Promise.reject(new Error('图片请求调度已关闭'))
      if (signal?.aborted) return Promise.reject(signal.reason)
      return new Promise<T>((resolve, reject) => {
        const item: Waiting = {
          reject, signal,
          abort: () => { const at = waiting.indexOf(item); if (at >= 0) waiting.splice(at, 1); reject(signal?.reason); drain() },
          start: () => {
            active++
            void Promise.resolve().then(() => { signal?.throwIfAborted(); return action() }).then(resolve, reject).finally(() => { active--; drain() })
          },
        }
        signal?.addEventListener('abort', item.abort, { once: true })
        waiting.push(item); drain()
      })
    },
    defer(ms: number) {
      if (!Number.isFinite(ms) || ms < 0 || ms > 2147483647) throw new Error('无效的限流等待时间')
      limited = true; until = Math.max(until, Date.now() + ms)
      changed(); drain()
    },
    concurrency,
    retryAt: () => until > Date.now() ? until : 0,
    refresh() { changed(); drain() },
    dispose() {
      closed = true; clearTimeout(timer)
      for (const item of waiting.splice(0)) { item.signal?.removeEventListener('abort', item.abort); item.reject(new Error('图片请求调度已关闭')) }
    },
  }
}

export type ImageRequestGate = ReturnType<typeof createImageRequestGate>
