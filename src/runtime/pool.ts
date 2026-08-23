export type PoolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error }

/**
 * Runs `worker` over `items` with bounded concurrency.
 * One failure never aborts the others — a crashed agent must not kill a round.
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = new Array(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results[i] = { ok: true, value: await worker(items[i]!, i) }
      } catch (e) {
        results[i] = { ok: false, error: e instanceof Error ? e : new Error(String(e)) }
      }
    }
  })

  await Promise.all(runners)
  return results
}
