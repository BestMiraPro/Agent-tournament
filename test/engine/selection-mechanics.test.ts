import { describe, expect, test } from 'vitest'
import { makeMockEngine } from '../helpers/mock-engine.js'

const GOAL = 'produce the best answer'

/**
 * Task 5 already unit-tests `planSelection` as a pure function. The gap these
 * tests close is whether the *driver* wires it up correctly: that the elite
 * genome really survives a round untouched, and that the agents the driver
 * retires are exactly the ones selection nominated. Both run through the real
 * engine, not against `planSelection` in isolation.
 */
async function runRounds(seed: number, population: number, rounds: number) {
  const ctx = makeMockEngine({ seed, populationSize: population })
  const run = ctx.engine.createRun('selection', GOAL)
  const results = []
  for (let i = 0; i < rounds; i++) {
    results.push(await ctx.engine.runRound(run.id, { goalMd: GOAL, criteriaMd: null }))
  }
  return { ...ctx, run, results }
}

describe('selection mechanics through the driver', () => {
  test('the elite genome is carried into the next round byte-identical', async () => {
    // This is the property that makes "best fitness never regresses" true. If the
    // elite were mutated, reflected, or re-parented, fitness could slide backwards.
    const { repos, results } = await runRounds(42, 12, 3)
    expect(results).toHaveLength(3)

    for (const r of results) {
      const ranked = repos.scores.forRound(r.roundId)
      const top = ranked[0]!
      expect(top.rank).toBe(1)
      expect(top.band).toBe('elite')

      const before = repos.genomes.forRound(top.agentId, r.roundIdx)!
      const after = repos.genomes.forRound(top.agentId, r.roundIdx + 1)

      expect(after).not.toBeNull()
      expect(after!.origin).toBe('elite')
      expect(after!.strategyMd).toBe(before.strategyMd)
      expect(after!.notesMd).toBe(before.notesMd)
      expect(after!.modelId).toBe(before.modelId)
      expect(after!.temperature).toBe(before.temperature)
      expect(after!.parentGenomeId).toBe(before.id)
    }
  })

  test('exactly the lowest-ranked agents are culled, never the top band', async () => {
    const { db, repos, run, results, config } = await runRounds(42, 12, 3)
    const { bottomPct, topPct } = config.selection

    for (const r of results) {
      const ranked = repos.scores.forRound(r.roundId) // ordered by rank
      const n = ranked.length
      const expectedCount = Math.floor(n * bottomPct)
      // Guard against this test quietly becoming vacuous if the config changes.
      expect(expectedCount).toBeGreaterThan(0)

      const expected = ranked
        .slice(n - expectedCount)
        .map((s) => s.agentId)
        .sort()

      const rows = db
        .prepare("SELECT id FROM agents WHERE run_id = ? AND status = 'culled' AND died_round = ?")
        .all(run.id, r.roundIdx) as { id: string }[]
      const actual = rows.map((a) => a.id).sort()

      expect(actual).toHaveLength(expectedCount)
      expect(actual).toEqual(expected)

      // Culling must never reach into the top band — that would let selection
      // delete the very agents it is supposed to propagate.
      const topBandSize = Math.max(1, Math.floor(n * topPct))
      const topBand = new Set(ranked.slice(0, topBandSize).map((s) => s.agentId))
      for (const id of actual) expect(topBand.has(id)).toBe(false)
    }
  })

  test('a round with crossoverPct > 0 writes crossover genomes', async () => {
    // bred through the real driver (not planSelection in isolation): the config
    // flows into the plan, the plan into breed. Four agents need a wide top band
    // (L >= 2 parents) and a non-empty cull set: topPct 0.5 -> top band of 2,
    // bottomPct 0.5 -> 2 culled, crossoverPct 1 -> both slots crossover.
    const ctx = makeMockEngine({ seed: 42, populationSize: 4 })
    ctx.config.selection = { eliteCount: 1, topPct: 0.5, bottomPct: 0.5, crossoverPct: 1 }
    const run = ctx.engine.createRun('crossover', GOAL)
    await ctx.engine.runRound(run.id, { goalMd: GOAL, criteriaMd: null })
    const rows = ctx.db
      .prepare("SELECT * FROM genomes WHERE origin = 'crossover'")
      .all() as unknown[]
    expect(rows).toHaveLength(2)
    // Population stays constant: 2 culled out, 2 crossover children in.
    expect(ctx.repos.agents.listActive(run.id)).toHaveLength(4)
  })
})
