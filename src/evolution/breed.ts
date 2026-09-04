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
}

/**
 * Writes the next generation. Elite genomes are copied verbatim; survivors take
 * their mutated genome; culled agents are retired and replaced by clones of top
 * performers, so population size is unchanged.
 */
export async function breed(input: BreedInput): Promise<void> {
  const { repos, runId, nextRoundIdx, plan, mutated } = input
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
    // ponytail: naive line-split merge — deterministic and free; upgrade path is
    // LLM-recombine if crossover proves load-bearing.
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
      const linesA = genomeA.strategyMd.split('\n')
      const linesB = genomeB.strategyMd.split('\n')
      // Odd-line rule: the extra line goes to A, the primary parent.
      const strategyMd = [
        ...linesA.slice(0, Math.ceil(linesA.length / 2)),
        ...linesB.slice(linesB.length - Math.floor(linesB.length / 2)),
      ].join('\n')
      repos.genomes.create({
        agentId: child.id,
        roundIdx: nextRoundIdx,
        strategyMd,
        notesMd: `Crossover of ${labelOf.get(x.parentAId) ?? x.parentAId} × ${labelOf.get(x.parentBId) ?? x.parentBId}.\n` + genomeA.notesMd,
        modelId: genomeA.modelId,
        temperature: genomeA.temperature,
        parentGenomeId: genomeA.id,
        origin: 'crossover',
      })
    }
  }
}
