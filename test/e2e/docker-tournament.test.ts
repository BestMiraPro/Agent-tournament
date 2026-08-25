import { access, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { runTournamentCli } from '../../src/cli.js'

const ENABLED = process.env.ARENA_DOCKER_E2E === '1'
const d = describe.skipIf(!ENABLED)

/**
 * Containers get provider credentials only through a bind-mounted auth.json — there is no
 * env-var path — so without one every agent fails on its first model call and the run
 * would look like a tournament failure rather than a missing credential. Default to the
 * host's own opencode credentials, overridable for a machine that keeps them elsewhere.
 */
const AUTH_FILE =
  process.env.ARENA_DOCKER_AUTH_FILE ??
  join(homedir(), '.local', 'share', 'opencode', 'auth.json')

const exists = async (p: string) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

let workspace = ''
afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

d('docker tournament (ARENA_DOCKER_E2E=1)', () => {
  test('runs agents inside containers and produces scored submissions', async () => {
    // Fail with the real reason rather than 30 minutes of authless agent errors.
    expect(
      await exists(AUTH_FILE),
      `no opencode auth.json at ${AUTH_FILE} — set ARENA_DOCKER_AUTH_FILE`,
    ).toBe(true)

    workspace = await mkdtemp(join(tmpdir(), 'arena-docker-e2e-'))
    const out = await runTournamentCli({
      goal: 'Write a single clear sentence defining what a tournament is.',
      rounds: 1,
      population: 2,
      seed: 42,
      dbPath: ':memory:',
      criteria: 'clarity, accuracy, concision',
      mode: 'real',
      sandbox: 'docker',
      workspaceRoot: workspace,
      authFile: AUTH_FILE,
      workerModels: ['wandb/deepseek-ai/DeepSeek-V4-Flash'],
      judgeModel: 'wandb/zai-org/GLM-5.2',
      reflectModel: 'wandb/deepseek-ai/DeepSeek-V4-Flash',
    })
    expect(out.rounds).toHaveLength(1)
    expect(out.rounds[0]!.meanScore).toBeGreaterThan(0)
  }, 1_800_000)
})
