export interface RankedAgent {
  agentId: string
  rank: number
  score: number
}

export interface SelectionConfig {
  eliteCount: number
  topPct: number
  bottomPct: number
  crossoverPct: number
}

export interface CloneAssignment {
  parentAgentId: string
  replacesAgentId: string
}

export interface CrossoverAssignment {
  parentAId: string
  parentBId: string
  replacesAgentId: string
}

export interface SelectionPlan {
  elite: string[]
  survivors: string[]
  culled: string[]
  clones: CloneAssignment[]
  crossovers: CrossoverAssignment[]
}

/**
 * Bands a ranked population.
 *
 * Clone count is DERIVED from cull count, never from topPct, so population size
 * stays invariant no matter how the ratios are configured. The elite band is a
 * subset of the top band: rank 1 is both preserved verbatim and a clone parent.
 */
export function planSelection(
  ranked: readonly RankedAgent[],
  cfg: SelectionConfig,
): SelectionPlan {
  const n = ranked.length
  if (n === 0) return { elite: [], survivors: [], culled: [], clones: [], crossovers: [] }

  if (!Number.isInteger(cfg.eliteCount) || cfg.eliteCount < 0) {
    throw new Error(`eliteCount must be a non-negative integer, got ${cfg.eliteCount}`)
  }
  if (!Number.isFinite(cfg.topPct) || !Number.isFinite(cfg.bottomPct)) {
    throw new Error('topPct and bottomPct must be finite numbers')
  }
  // WHY stricter than the sibling pcts: crossoverPct indexes parent pairs, so a
  // non-finite or out-of-range value corrupts pairing rather than just sizing.
  if (!Number.isFinite(cfg.crossoverPct) || cfg.crossoverPct < 0 || cfg.crossoverPct > 1) {
    throw new Error(`crossoverPct must be a finite number in [0, 1], got ${cfg.crossoverPct}`)
  }

  const sorted = [...ranked].sort((a, b) => a.rank - b.rank)
  const eliteCount = Math.min(cfg.eliteCount, n)
  // Floor of 1 (not of eliteCount): the top band must stay non-empty for tiny
  // populations, but must NOT stretch to accommodate an oversized eliteCount —
  // otherwise the eliteCount-vs-top-band guard below becomes unreachable.
  const topCount = Math.max(1, Math.floor(n * cfg.topPct))

  if (cfg.eliteCount > topCount) {
    throw new Error(
      `eliteCount (${cfg.eliteCount}) cannot exceed the top band size (${topCount})`,
    )
  }

  // Never cull into the top band — that would let selection delete the elite.
  const maxCullable = Math.max(0, n - topCount)
  const bottomCount = Math.min(Math.floor(n * cfg.bottomPct), maxCullable)

  const ids = sorted.map((r) => r.agentId)
  const elite = ids.slice(0, eliteCount)
  const culled = bottomCount > 0 ? ids.slice(n - bottomCount) : []
  const survivors = ids.slice(eliteCount, n - bottomCount)
  const topBand = ids.slice(0, topCount)

  const clones: CloneAssignment[] = culled.map((replacesAgentId, i) => ({
    parentAgentId: topBand[i % topBand.length]!,
    replacesAgentId,
  }))

  // WHY forced to 0 for a singleton top band: single-parent crossover is a clone
  // with extra steps. Consecutive indices mod L are always distinct when L > 1,
  // so no extra distinctness check is needed. The FIRST numCrossover culled slots
  // become crossovers; the rest stay clones with their original parents.
  const numCrossover = topBand.length < 2
    ? 0
    : Math.min(culled.length, Math.floor(culled.length * cfg.crossoverPct))
  const crossovers: CrossoverAssignment[] = culled.slice(0, numCrossover).map((replacesAgentId, i) => ({
    parentAId: topBand[(2 * i) % topBand.length]!,
    parentBId: topBand[(2 * i + 1) % topBand.length]!,
    replacesAgentId,
  }))

  return { elite, survivors, culled, clones: clones.slice(numCrossover), crossovers }
}
