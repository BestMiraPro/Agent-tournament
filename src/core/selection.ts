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

export interface SelectionPlan {
  elite: string[]
  survivors: string[]
  culled: string[]
  clones: CloneAssignment[]
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
  if (n === 0) return { elite: [], survivors: [], culled: [], clones: [] }

  if (!Number.isInteger(cfg.eliteCount) || cfg.eliteCount < 0) {
    throw new Error(`eliteCount must be a non-negative integer, got ${cfg.eliteCount}`)
  }
  if (!Number.isFinite(cfg.topPct) || !Number.isFinite(cfg.bottomPct)) {
    throw new Error('topPct and bottomPct must be finite numbers')
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

  return { elite, survivors, culled, clones }
}
