/**
 * One timer per leased run: holding it again pushes the deadline back, and `onExpire` runs once it
 * passes with nobody holding it. Timers are unref'd, so a lease never keeps the process alive.
 */
export class RunLeases {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly onExpire: (runId: string) => void) {}

  hold(runId: string, ms: number): void {
    this.release(runId)
    const timer = setTimeout(() => {
      this.timers.delete(runId)
      this.onExpire(runId)
    }, ms)
    timer.unref?.()
    this.timers.set(runId, timer)
  }

  release(runId: string): void {
    clearTimeout(this.timers.get(runId))
    this.timers.delete(runId)
  }

  releaseAll(): void {
    for (const runId of [...this.timers.keys()]) this.release(runId)
  }
}
