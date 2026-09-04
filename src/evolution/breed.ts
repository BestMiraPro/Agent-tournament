import type { SelectionPlan } from '../core/selection.js'
import type { Genome } from '../core/types.js'
import type { Repos } from '../db/repos.js'

export interface BreedInput {
  repos: Repos
  runId: string
  nextRoundIdx: number
  plan: SelectionPlan
  /** Reflection output per surviving agent. Elite agents are absent by design. */
  mutated: Map<string, Genome>
  /**
   * Narrow LLM seam for crossover recombination: given both parents' strategies,
   * returns the merged child text. The caller binds goal/model/provider in the
   * closure, so breed threads no config and no provider. Absent (tests, legacy
   * callers) every crossover degrades to the deterministic split-merge below.
   */
  recombine?: RecombineFn
}

/**
 * One crossover child per call — so pct 0 (no crossover slots in the plan)
 * costs zero LLM calls by construction, and the default stays free.
 */
export type RecombineFn = (
  strategyA: string,
  strategyB: string,
) => Promise<{ strategyMd: string; notesMd: string }>

/** Deterministic 4d split-merge: first ceil-half of A's lines + last floor-half of B's. */
function splitMerge(strategyA: string, strategyB: string): string {
  const linesA = strategyA.split('\n')
  const linesB = strategyB.split('\n')
  // Odd-line rule: the extra line goes to A, the primary parent.
  return [
    ...linesA.slice(0, Math.ceil(linesA.length / 2)),
    ...linesB.slice(linesB.length - Math.floor(linesB.length / 2)),
  ].join('\n')
}

/**
 * Writes the next generation. Elite genomes are copied verbatim; survivors take
 * their mutated genome; culled agents are retired and replaced by clones of top
 * performers, so population size is unchanged.
 */
export async function breed(input: BreedInput): Promise<void> {
  const { repos, runId, nextRoundIdx, plan, mutated, recombine } = input
  const prevIdx = nextRoundIdx - 1

  for (const agentId of plan.elite) {
    const prev = repos.genomes.forRound(agentId, prevIdx)
    if (!prev) continue
    repos.genomes.create({
      agentId,
      roundIdx: nextRoundIdx,
      strategyMd: prev.strategyMd,
      notesMd: prev.notesMd,
      modelId: prev.modelId,
      temperature: prev.temperature,
      parentGenomeId: prev.id,
      origin: 'elite',
    })
  }

  for (const agentId of plan.survivors) {
    const prev = repos.genomes.forRound(agentId, prevIdx)
    if (!prev) continue
    const next = mutated.get(agentId)
    repos.genomes.create({
      agentId,
      roundIdx: nextRoundIdx,
      strategyMd: next?.strategyMd ?? prev.strategyMd,
      notesMd: next?.notesMd ?? prev.notesMd,
      modelId: next?.modelId ?? prev.modelId,
      temperature: next?.temperature ?? prev.temperature,
      parentGenomeId: prev.id,
      origin: 'mutation',
    })
  }

  for (const agentId of plan.culled) {
    repos.agents.retire(agentId, prevIdx, 'culled')
  }

  let childIndex = 0
  for (const clone of plan.clones) {
    const parentGenome = repos.genomes.forRound(clone.parentAgentId, prevIdx)
    if (!parentGenome) continue
    childIndex++
    const child = repos.agents.create({
      runId,
      label: `competitor-r${nextRoundIdx}-${childIndex}`,
      parentAgentId: clone.parentAgentId,
      bornRound: nextRoundIdx,
    })
    repos.genomes.create({
      agentId: child.id,
      roundIdx: nextRoundIdx,
      strategyMd: parentGenome.strategyMd,
      notesMd: parentGenome.notesMd,
      modelId: parentGenome.modelId,
      temperature: parentGenome.temperature,
      parentGenomeId: parentGenome.id,
      origin: 'clone',
    })
  }

  if (plan.crossovers.length > 0) {
    const labelOf = new Map(repos.agents.listAll(runId).map((a) => [a.id, a.label]))
    for (const x of plan.crossovers) {
      const genomeA = repos.genomes.forRound(x.parentAId, prevIdx)
      const genomeB = repos.genomes.forRound(x.parentBId, prevIdx)
      if (!genomeA || !genomeB) continue
      childIndex++
      const child = repos.agents.create({
        runId,
        label: `competitor-r${nextRoundIdx}-${childIndex}`,
        parentAgentId: x.parentAId,
        bornRound: nextRoundIdx,
      })
      const labelA = labelOf.get(x.parentAId) ?? x.parentAId
      const labelB = labelOf.get(x.parentBId) ?? x.parentBId
      let strategyMd: string | null = null
      let notesMd: string | null = null
      if (recombine) {
        try {
          const merged = await recombine(genomeA.strategyMd, genomeB.strategyMd)
          if (merged.strategyMd.trim().length === 0) throw new Error('recombine returned an empty strategy')
          strategyMd = merged.strategyMd.trim()
          // Provenance is about lineage, not method: the exact 4d prefix on
          // both paths, followed by the recombined notes verbatim.
          notesMd = `Crossover of ${labelA} × ${labelB}.\n` + merged.notesMd
        } catch {
          // Fall through to split-merge below. A crossover slot must NEVER fail
          // a round — same philosophy as reflection carry-forward in reflect.ts.
        }
      }
      if (strategyMd === null || notesMd === null) {
        strategyMd = splitMerge(genomeA.strategyMd, genomeB.strategyMd)
        // The parenthetical marks the method, not the lineage: only a seam that
        // was present and failed earns it, so the no-seam path stays byte-identical to 4d.
        const failed = recombine !== undefined ? ' (recombine failed, split merge)' : ''
        notesMd = `Crossover of ${labelA} × ${labelB}${failed}.\n` + genomeA.notesMd
      }
      repos.genomes.create({
        agentId: child.id,
        roundIdx: nextRoundIdx,
        strategyMd,
        notesMd,
        modelId: genomeA.modelId,
        temperature: genomeA.temperature,
        parentGenomeId: genomeA.id,
        origin: 'crossover',
      })
    }
  }
}
