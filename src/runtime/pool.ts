export type PoolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error }

export interface PoolOpts {
  /**
   * Cooperative stop: workers stop pulling NEW items when this returns true.
   * In-flight calls run to completion — never killed mid-call, because agent
   * timeouts already bound in-flight work and killing the promise would only
   * orphan it.
   */
  shouldStop?: () => boolean
}

/**
 * Runs `worker` over `items` with bounded concurrency.
 * One failure never aborts the others — a crashed agent must not kill a round.
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  opts?: PoolOpts,
): Promise<PoolResult<R>[]> {
  const results: PoolResult<R>[] = new Array(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      if (opts?.shouldStop?.()) return
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
  // Items no worker ever pulled resolve in the same failure shape as a worker
  // exception — no new result variant for callers to handle.
  for (let i = 0; i < items.length; i++) {
    if (results[i] === undefined) results[i] = { ok: false, error: new Error('round aborted') }
  }
  return results
}
