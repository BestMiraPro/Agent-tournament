import { jaccardDistance, strategyWordSet } from './analytics.js'

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
  diversityFloor: boolean
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
  rescued: string[]
}

/** Strategy text per agent, for the diversityFloor rescue. Accepts either map shape. */
export type StrategyTexts = Map<string, string> | Record<string, string>

/**
 * Bands a ranked population.
 *
 * Clone count is DERIVED from cull count, never from topPct, so population size
 * stays invariant no matter how the ratios are configured. The elite band is a
 * subset of the top band: rank 1 is both preserved verbatim and a clone parent.
 *
 * diversityFloor (default off — byte-identical when false): rescues the single
 * culled agent with the highest mean pairwise strategy distance to the rest of
 * the population. `strategies` is ignored entirely when the floor is off. When
 * on, a culled agent with no strategy text scores 0 (fail-safe toward culling,
 * never rescue-by-default); pairs against agents with no text are skipped.
 */
export function planSelection(
  ranked: readonly RankedAgent[],
  cfg: SelectionConfig,
  strategies?: StrategyTexts,
): SelectionPlan {
  const n = ranked.length
  if (n === 0) return { elite: [], survivors: [], culled: [], clones: [], crossovers: [], rescued: [] }

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
  let culled = bottomCount > 0 ? ids.slice(n - bottomCount) : []
  let survivors = ids.slice(eliteCount, n - bottomCount)
  const topBand = ids.slice(0, topCount)

  // Diversity floor: culled and survivors exclude the elite slice by
  // construction, so the rescue/bump below can never touch the elite band.
  // Rescued agents keep their judged bottom band (they WERE culled — honest, so
  // no snapshot/event change); breed needs none either (rescued flow through
  // the survivors/mutated path).
  let rescued: string[] = []
  if (cfg.diversityFloor && culled.length > 0 && survivors.length > 0) {
    const textOf = (id: string): string | undefined =>
      strategies instanceof Map ? strategies.get(id) : strategies?.[id]
    // Tokenize once per agent; missing texts stay absent (skipped as pair
    // partners, and a missing culled text scores 0 — see below).
    const words = new Map<string, Set<string>>()
    for (const id of ids) {
      const text = textOf(id)
      if (text !== undefined) words.set(id, strategyWordSet(text))
    }
    let bestId = culled[0]!
    let bestScore = -1
    for (const id of culled) {
      // Fail-safe toward culling: no text means no evidence of distinctness.
      if (!words.has(id)) continue
      const mine = words.get(id)!
      let sum = 0
      let pairs = 0
      for (const other of ids) {
        if (other === id) continue
        const theirs = words.get(other)
        if (!theirs) continue
        sum += jaccardDistance(mine, theirs)
        pairs++
      }
      // Strictly-greater keeps the FIRST max on ties — deterministic.
      const score = pairs === 0 ? 0 : sum / pairs
      if (score > bestScore) {
        bestScore = score
        bestId = id
      }
    }
    // No-text culled agents keep the initial -1 (never the max): no text means
    // no evidence of distinctness, so the floor fails safe toward culling. But
    // a present text scoring exactly 0 still beats -1, so an all-identical field
    // deterministically rescues the first culled agent (tie → first max wins).
    // The has-text guard below covers the all-missing field: with no evidence
    // at all, nobody is rescued.
    if (words.has(bestId)) {
      rescued = [bestId]
      // Bump the lowest-ranked survivor (last of the rank-sorted slice) into the
      // culled set; the rescued agent takes a survivor slot. Totals unchanged.
      const bumped = survivors[survivors.length - 1]!
      survivors = [...survivors.slice(0, -1), bestId]
      culled = [...culled.filter((id) => id !== bestId), bumped]
    }
  }

  // Clones/crossovers derive from the FINAL culled set — after the floor swap —
  // so every culled agent is replaced exactly once and the rescued one is not.
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

  return { elite, survivors, culled, clones: clones.slice(numCrossover), crossovers, rescued }
}
