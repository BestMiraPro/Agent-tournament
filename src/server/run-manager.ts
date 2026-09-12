import type { EventSink } from '../engine/events.js'
import type { TournamentEngine } from '../engine/driver.js'

export interface StartRoundInput {
  goalMd: string
  criteriaMd: string | null
}

/**
 * Drives rounds in the background so an HTTP request never blocks on a tournament
 * that takes minutes. Progress reaches the browser through events, not the response.
 */
export class RunManager {
  private inFlight = new Map<string, Promise<void>>()
  private errors = new Map<string, string>()
  /**
   * Every run this manager has driven, not only the busy ones.
   *
   * `inFlight` is cleared the moment a round settles, so disposing from that map alone
   * skips every run that finished normally — and with Docker those runs still own live
   * shard containers. What needs releasing is ownership, which outlives busyness.
   */
  private owned = new Set<string>()
  private disposing = false
  private disposal: Promise<void> | null = null

  constructor(private engine: TournamentEngine, private emit: EventSink) {}

  isBusy(runId: string): boolean {
    return this.inFlight.has(runId)
  }

  lastError(runId: string): string | null {
    return this.errors.get(runId) ?? null
  }

  startRound(runId: string, input: StartRoundInput): void {
    if (this.disposing) {
      throw new Error('run manager is disposing')
    }
    if (this.inFlight.has(runId)) {
      throw new Error(`a round is already running for run ${runId}`)
    }
    this.errors.delete(runId)
    this.owned.add(runId)

    const task = (async () => {
      try {
        await this.engine.runRound(runId, input)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        this.errors.set(runId, message)
        // The round driver already marks the round failed in the database; this makes
        // the failure visible to a dashboard that is only listening to events.
        this.emit({ type: 'round.complete', runId, roundIdx: -1, budgetBreach: message })
      } finally {
        this.inFlight.delete(runId)
      }
    })()

    this.inFlight.set(runId, task)
  }

  /** Cooperative abort: flags the in-flight round so queued agents stop, tracked
   *  sessions are aborted, and the driver fails the round at its next gate.
   *  False when idle — sets nothing. */
  abortRound(runId: string): boolean {
    if (!this.inFlight.has(runId)) return false
    this.engine.abortRound(runId)
    return true
  }

  /** Resolves once no round is running for this run. */
  async waitForIdle(runId: string): Promise<void> {
    const task = this.inFlight.get(runId)
    if (task) await task
  }

  /**
   * Stops accepting work, waits for whatever is running, then releases every owned run.
   *
   * Memoised so a second caller joins the first attempt instead of disposing twice —
   * shutdown paths call this from more than one place.
   */
  disposeAll(): Promise<void> {
    // Set synchronously: a startRound racing this call must be refused, not queued.
    this.disposing = true
    return (this.disposal ??= (async () => {
      for (const task of [...this.inFlight.values()]) await task.catch(() => {})
      for (const runId of this.owned) await this.engine.dispose(runId).catch(() => {})
      this.owned.clear()
    })())
  }
}
