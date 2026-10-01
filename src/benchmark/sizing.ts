/**
 * The Task C acceptance rule as assertions on recorded benchmark measurements.
 *
 * A candidate (lifecycle × memory limit × simultaneous count) is eligible for
 * recommendation only when every repetition completes, nothing OOMs, every expected
 * submission is present, worker peaks stay below 80% of the configured limit, cleanup
 * leaves no worker/gateway resources, repeated rounds do not accumulate
 * endpoint/session bookkeeping, and admission needed no host changes. Unknown
 * readings fail closed: a missing peak or OOM counter is not evidence of headroom.
 */

/** One worker's measured round: container identity, limits, memory, outcome. */
export interface WorkerRoundMeasurement {
  worker: string
  containerId: string | null
  memoryLimitBytes: number
  peakBytes: number | null
  currentBytes: number | null
  anonBytes: number | null
  tmpfsBytes: number | null
  /** cgroup `memory.events` oom_kill; null when unreadable. */
  oomKills: number | null
  /** Daemon's OOMKilled flag; null when the daemon would not say. */
  oomKilled: boolean | null
  exitCode: number | null
  running: boolean
  readyMs: number | null
  completed: boolean
  submissionsExpected: number
  submissionsPresent: number
  cleanupMs: number | null
  /** Worker/gateway resources still present after cleanup; empty is clean. */
  leftovers: string[]
  /** Model→tool→model exchanges observed for this worker in this round. */
  toolTurns: number
}

/** Host-side runtime bookkeeping at a round boundary, to catch accumulation. */
export interface RoundBookkeeping {
  round: number
  endpoints: number
  sessions: number
}

export interface RepetitionEvidence {
  completedRounds: number
  workers: WorkerRoundMeasurement[]
  bookkeeping: RoundBookkeeping[]
}

export interface CandidateEvidence {
  lifecycle: 'retained' | 'recycled'
  memory: string
  simultaneous: number
  /** Protocol floor: tool-response turns per worker per round. */
  minToolTurns: number
  /** Protocol length in rounds. */
  rounds: number
  admittedWithoutHostChanges: boolean
  repetitions: RepetitionEvidence[]
}

export interface CandidateVerdict {
  eligible: boolean
  failures: string[]
}

/** Fraction of the configured limit a worker's peak must stay below. */
export const PEAK_FRACTION = 0.8

export function evaluateCandidate(evidence: CandidateEvidence): CandidateVerdict {
  const failures: string[] = []
  if (!evidence.admittedWithoutHostChanges) {
    failures.push('admission needed host setting changes or stopping unrelated applications')
  }
  if (evidence.repetitions.length === 0) {
    failures.push('no repetition completed')
    return { eligible: false, failures }
  }
  evidence.repetitions.forEach((rep, i) => {
    const tag = `repetition ${i + 1}`
    if (rep.completedRounds !== evidence.rounds) {
      failures.push(`${tag}: completed ${rep.completedRounds} of ${evidence.rounds} rounds`)
    }
    for (const w of rep.workers) {
      if (!w.completed) failures.push(`${tag}: ${w.worker} did not complete the workload`)
      if (w.oomKills === null || w.oomKilled === null) {
        failures.push(`${tag}: ${w.worker} has an unreadable OOM reading, so no-OOM cannot be claimed`)
      } else if (w.oomKills > 0 || w.oomKilled) {
        failures.push(`${tag}: ${w.worker} was OOM-killed (cgroup oom_kill=${w.oomKills})`)
      }
      if (w.submissionsPresent < w.submissionsExpected) {
        failures.push(`${tag}: ${w.worker} has ${w.submissionsPresent} of ${w.submissionsExpected} expected submissions`)
      }
      if (w.peakBytes === null) {
        failures.push(`${tag}: ${w.worker} has no peak reading, so headroom cannot be claimed`)
      } else if (w.peakBytes >= PEAK_FRACTION * w.memoryLimitBytes) {
        failures.push(
          `${tag}: ${w.worker} peaked at ${Math.round(w.peakBytes / 1024 ** 2)} MiB, ` +
            `at or above 80% of ${w.memoryLimitBytes / 1024 ** 3}g`,
        )
      }
      if (w.leftovers.length > 0) {
        failures.push(`${tag}: ${w.worker} left resources behind: ${w.leftovers.join(', ')}`)
      }
      if (w.toolTurns < evidence.minToolTurns) {
        failures.push(`${tag}: ${w.worker} ran ${w.toolTurns} tool turns, below the protocol floor of ${evidence.minToolTurns}`)
      }
    }
    if (rep.bookkeeping.length > 0) {
      const first = rep.bookkeeping[0]!
      const last = rep.bookkeeping[rep.bookkeeping.length - 1]!
      if (last.endpoints > first.endpoints || last.sessions > first.sessions) {
        failures.push(
          `${tag}: bookkeeping grew from round ${first.round} to ${last.round} ` +
            `(endpoints ${first.endpoints}→${last.endpoints}, sessions ${first.sessions}→${last.sessions})`,
        )
      }
    }
  })
  return { eligible: failures.length === 0, failures }
}

/** The highest simultaneous count with an eligible verdict, or 0 when none passed. */
export function recommendSimultaneous(
  results: { evidence: CandidateEvidence; verdict: CandidateVerdict }[],
): number {
  let best = 0
  for (const r of results) {
    if (r.verdict.eligible && r.evidence.simultaneous > best) best = r.evidence.simultaneous
  }
  return best
}

/**
 * The default changes to 768m only on a passing protocol. Anything else retains 1g:
 * the measured workload qualifies, not arbitrary future tasks.
 */
export function recommendDefault(input: { passing768m: boolean; ceiling768m: number; ceiling1g: number }): '768m' | '1g' {
  void input.ceiling768m
  void input.ceiling1g
  return input.passing768m ? '768m' : '1g'
}
