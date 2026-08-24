import { describe, expect, test } from 'vitest'
import { runTournamentCli } from '../src/cli.js'

describe('runTournamentCli', () => {
  test('runs the requested number of rounds and reports fitness per round', async () => {
    const out = await runTournamentCli({
      goal: 'write a good answer',
      rounds: 3,
      population: 6,
      seed: 42,
      dbPath: ':memory:',
      criteria: null,
    })
    expect(out.rounds).toHaveLength(3)
    expect(out.rounds[0]!.meanScore).toBeGreaterThan(0)
    expect(out.rounds.at(-1)!.meanScore).toBeGreaterThan(out.rounds[0]!.meanScore)
  })

  test('reports the winning strategy of the final round', async () => {
    const out = await runTournamentCli({
      goal: 'write a good answer', rounds: 2, population: 4,
      seed: 1, dbPath: ':memory:', criteria: null,
    })
    expect(out.winner.strategyMd.length).toBeGreaterThan(0)
  })
})

describe('CLI mode selection', () => {
  test('mock mode still runs and improves', async () => {
    const out = await runTournamentCli({
      goal: 'write a good answer', rounds: 3, population: 6, seed: 42,
      dbPath: ':memory:', criteria: null, mode: 'mock',
    })
    expect(out.rounds).toHaveLength(3)
    expect(out.rounds.at(-1)!.meanScore).toBeGreaterThan(out.rounds[0]!.meanScore)
  })

  test('real mode requires a workspace root', async () => {
    await expect(
      runTournamentCli({
        goal: 'g', rounds: 1, population: 2, seed: 1,
        dbPath: ':memory:', criteria: null, mode: 'real',
      }),
    ).rejects.toThrow(/workspaceRoot/i)
  })
})
