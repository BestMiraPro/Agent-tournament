import { describe, expect, test } from 'vitest'
import { makeMockEngine } from '../helpers/mock-engine.js'

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

async function runTournament(
  seed: number,
  rounds: number,
  population: number,
  opts: { scrambleRanks?: boolean } = {},
) {
  const { engine, repos } = makeMockEngine({
    seed,
    populationSize: population,
    scrambleRanks: opts.scrambleRanks,
  })
  const run = engine.createRun('evolution', 'produce the best answer')
  const perRound: number[][] = []
  const roundIds: string[] = []
  for (let i = 0; i < rounds; i++) {
    const r = await engine.runRound(run.id, { goalMd: 'produce the best answer', criteriaMd: null })
    perRound.push(repos.scores.forRound(r.roundId).map((s) => s.score))
    roundIds.push(r.roundId)
  }
  return { perRound, repos, run, roundIds }
}

describe('evolution', () => {
  test('mean fitness increases from the first round to the last', async () => {
    const { perRound } = await runTournament(42, 5, 8)
    expect(mean(perRound.at(-1)!)).toBeGreaterThan(mean(perRound[0]!))
  })

  test('best fitness never regresses, because the elite is preserved', async () => {
    const { perRound } = await runTournament(42, 5, 8)
    const bests = perRound.map((r) => Math.max(...r))
    for (let i = 1; i < bests.length; i++) {
      // Judge jitter is bounded at 0.5 in MockProvider; allow exactly that.
      expect(bests[i]!).toBeGreaterThanOrEqual(bests[i - 1]! - 0.5)
    }
  })

  test('is deterministic for a fixed seed', async () => {
    const a = await runTournament(7, 3, 6)
    const b = await runTournament(7, 3, 6)
    expect(a.perRound).toEqual(b.perRound)
  })

  test('population size holds constant across every round', async () => {
    const { perRound } = await runTournament(42, 5, 8)
    for (const round of perRound) expect(round).toHaveLength(8)
  })

  test('improvement depends on the fitness signal, not the loop running', async () => {
    // Identical seeds, population and rounds in both arms. The only difference is
    // that the scrambled arm reassigns ranks at random after judging, so selection
    // and reflection act on noise instead of fitness. If the loop were improving
    // for reasons unrelated to fitness, the two arms would end up level.
    //
    // Averaged over a few seeds rather than run on one: a single seed at
    // population 8 is knife-edge (measured: 9 of 60 seeds show no separation, and
    // one shows an exact tie), which would make this a coin flip dressed up as an
    // assertion. Three seeds at population 12 separate on 30 of 30 batches tested,
    // with a worst-case margin of 1.59.
    const seeds = [42, 7, 1]
    const arm = async (scrambleRanks: boolean) => {
      const finals: number[] = []
      for (const seed of seeds) {
        const { perRound } = await runTournament(seed, 5, 12, { scrambleRanks })
        finals.push(mean(perRound.at(-1)!))
      }
      return mean(finals)
    }
    expect(await arm(false)).toBeGreaterThan(await arm(true))
  })

  test('round 1 population contains multiple distinct strategies', async () => {
    // Imitation can only transfer what some agent already has. If the seed
    // strategies ever collapse back to identical text, the evolution tests above
    // stop meaning anything, so pin the precondition here.
    const { repos, run, roundIds } = await runTournament(42, 1, 8)
    const strategies = repos.scores
      .forRound(roundIds[0]!)
      .map((s) => repos.genomes.forRound(s.agentId, 1)?.strategyMd ?? '')
    expect(new Set(strategies).size).toBeGreaterThan(1)
  })

  test('lineage is intact — every non-seed agent has a parent that existed', async () => {
    const { repos, run } = await runTournament(42, 4, 8)
    const active = repos.agents.listActive(run.id)
    for (const a of active) {
      if (a.bornRound > 1) expect(a.parentAgentId).not.toBeNull()
    }
  })
})
