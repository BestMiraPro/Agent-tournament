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

  constructor(private engine: TournamentEngine, private emit: EventSink) {}

  isBusy(runId: string): boolean {
    return this.inFlight.has(runId)
  }

  lastError(runId: string): string | null {
    return this.errors.get(runId) ?? null
  }

  startRound(runId: string, input: StartRoundInput): void {
    if (this.inFlight.has(runId)) {
      throw new Error(`a round is already running for run ${runId}`)
    }
    this.errors.delete(runId)

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

  /** Resolves once no round is running for this run. */
  async waitForIdle(runId: string): Promise<void> {
    const task = this.inFlight.get(runId)
    if (task) await task
  }

  async disposeAll(): Promise<void> {
    for (const [runId, task] of this.inFlight) {
      await task.catch(() => {})
      await this.engine.dispose(runId).catch(() => {})
    }
  }
}
