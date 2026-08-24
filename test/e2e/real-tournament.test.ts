import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { runTournamentCli } from '../../src/cli.js'

const ENABLED = process.env.ARENA_E2E === '1'
const d = describe.skipIf(!ENABLED)

let workspace = ''
afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

d('real tournament (ARENA_E2E=1)', () => {
  test('runs 2 rounds of 3 agents on free models and produces submissions', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'arena-e2e-'))
    const out = await runTournamentCli({
      goal: 'Write a single clear sentence defining what a tournament is.',
      rounds: 2,
      population: 3,
      seed: 42,
      dbPath: ':memory:',
      criteria: 'clarity, accuracy, concision',
      mode: 'real',
      workspaceRoot: workspace,
      workerModels: ['opencode/big-pickle'],
      judgeModel: 'wandb/zai-org/GLM-5.2',
      reflectModel: 'wandb/deepseek-ai/DeepSeek-V4-Flash',
    })

    expect(out.rounds).toHaveLength(2)
    // Every agent must have produced a real score; a flat zero means nothing ran.
    expect(out.rounds[0]!.meanScore).toBeGreaterThan(0)
    expect(out.winner.strategyMd.length).toBeGreaterThan(0)
  }, 900_000)
})
