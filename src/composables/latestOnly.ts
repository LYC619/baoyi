export const STALE = Symbol('stale')

/** 后一次调用开始后，前一次的结果和错误都作废。 */
export function latestOnly<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  let current = 0
  return async (...args: A): Promise<R | typeof STALE> => {
    const id = ++current
    try {
      const result = await fn(...args)
      return id === current ? result : STALE
    } catch (err) {
      if (id === current) throw err
      return STALE
    }
  }
}
