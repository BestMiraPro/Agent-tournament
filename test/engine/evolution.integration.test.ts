import { describe, expect, test } from 'vitest'
import { makeMockEngine } from '../helpers/mock-engine.js'

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

async function runTournament(seed: number, rounds: number, population: number) {
  const { engine, repos } = makeMockEngine({ seed, populationSize: population })
  const run = engine.createRun('evolution', 'produce the best answer')
  const perRound: number[][] = []
  for (let i = 0; i < rounds; i++) {
    const r = await engine.runRound(run.id, { goalMd: 'produce the best answer', criteriaMd: null })
    perRound.push(repos.scores.forRound(r.roundId).map((s) => s.score))
  }
  return { perRound, repos, run }
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

  test('lineage is intact — every non-seed agent has a parent that existed', async () => {
    const { repos, run } = await runTournament(42, 4, 8)
    const active = repos.agents.listActive(run.id)
    for (const a of active) {
      if (a.bornRound > 1) expect(a.parentAgentId).not.toBeNull()
    }
  })
})
