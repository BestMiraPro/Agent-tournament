import type { AgentFailure } from '../../core/failure.js'
import { subscriptionLimitFailure, type RateLimitReading } from './stream.js'

/** How long a rejection without a reset time keeps the gate closed. */
const FALLBACK_BLOCK_MS = 60_000

/**
 * The subscription's usage limit, shared by every Claude call in this process: they all draw on
 * one subscription. Once a call is refused for the limit, later attempts fail at once with the same
 * explanation until the reset, instead of starting a CLI each to be refused again.
 */
export class SubscriptionLimitGate {
  private blockedUntil = 0
  private reading: RateLimitReading | null = null

  constructor(private now: () => number = Date.now) {}

  observe(reading: RateLimitReading): void {
    this.reading = reading
    if (reading.status === 'rejected') {
      this.blockedUntil = reading.resetsAt !== null ? reading.resetsAt * 1000 : this.now() + FALLBACK_BLOCK_MS
    }
  }

  /** The refusal to report while the limit holds, or null. */
  blocked(): AgentFailure | null {
    if (this.now() >= this.blockedUntil) return null
    return subscriptionLimitFailure(this.reading)
  }

  last(): RateLimitReading | null {
    return this.reading
  }
}

/** The process's one Claude subscription gate. */
export const claudeLimitGate = new SubscriptionLimitGate()
