import type { StreamHealth } from '../api.js'

/** Silence longer than this is worth saying out loud on a working agent's card. */
export const SILENCE_WARNING_SECONDS = 30

function duration(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}

/**
 * How old the latest observed evidence for an agent is.
 *
 * Long silence is described as what it is — no events received — never as a stall: an agent
 * running a long command produces no events, and the dashboard cannot tell that apart from a
 * hang. Nothing here manufactures a heartbeat.
 */
export function evidenceAgeLabel(lastObservedAt: number | null | undefined, now: number, status: string): string {
  if (lastObservedAt === undefined || lastObservedAt === null) return ''
  const seconds = Math.max(0, Math.floor((now - lastObservedAt) / 1000))
  return status === 'running' && seconds >= SILENCE_WARNING_SECONDS
    ? `No activity received for ${duration(seconds)}`
    : `${duration(seconds)} ago`
}

/** A warning when any upstream OpenCode stream is down — separate from the browser's socket. */
export function activityStreamWarning(streams: Record<string, StreamHealth>): string | null {
  return Object.values(streams).some((s) => s.state === 'reconnecting') ? 'Activity stream reconnecting' : null
}
