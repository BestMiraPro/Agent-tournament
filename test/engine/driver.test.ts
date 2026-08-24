import { describe, expect, test, vi } from 'vitest'
import { makeMockEngine } from '../helpers/mock-engine.js'
import { parseGenome } from '../../src/core/genome.js'

describe('TournamentEngine', () => {
  test('seeds the population from the roster', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 6 })
    const run = engine.createRun('test', 'write a good answer')
    expect(repos.agents.listActive(run.id)).toHaveLength(6)
  })

  test('a round produces one score per agent', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 6 })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.scores.forRound(round.roundId)).toHaveLength(6)
  })

  test('a completed round is marked complete', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 6 })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })

  test('population size is stable across rounds', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 10 })
    const run = engine.createRun('test', 'goal')
    for (let i = 0; i < 3; i++) await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.agents.listActive(run.id)).toHaveLength(10)
  })

  test('a failing agent does not abort the round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 6, failFirst: true })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const scores = repos.scores.forRound(round.roundId)
    expect(scores).toHaveLength(6)
    expect(scores.some((s) => s.score === 0)).toBe(true)
  })

  test('writes the genome into the agent workspace so it can be read by an agent runner', async () => {
    const { engine, repos, sandbox } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const agent = repos.agents.listActive(run.id)[0]!
    const storedGenome = repos.genomes.forRound(agent.id, round.roundIdx)!

    const handle = { agentId: agent.id, workspacePath: '', baseUrl: '' }
    const written = await sandbox.readFile(handle, '.opencode/agents/competitor.md')
    expect(written).not.toBeNull()

    const parsed = parseGenome(written!)
    expect(parsed.strategyMd).toBe(storedGenome.strategyMd)
    expect(parsed.modelId).toBe(storedGenome.modelId)
    expect(parsed.temperature).toBe(storedGenome.temperature)
  })

  test('records the resolved criteria on the round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: 'my rules' })
    const r = repos.rounds.get(round.roundId)!
    expect(r.criteriaMd).toBe('my rules')
    expect(r.criteriaSource).toBe('user')
  })
})

describe('driver hardening', () => {
  test('persists one submission row per agent', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.submissions.forRound(round.roundId)).toHaveLength(4)
  })

  test('records round start, end and judge mode', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const r = repos.rounds.get(round.roundId)!
    expect(r.startedAt).toBeGreaterThan(0)
    expect(r.endedAt).toBeGreaterThan(0)
    expect(r.judgeMode).toBe('single_call')
  })

  test('assigns the top band to high performers', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 10 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const bands = new Set(repos.scores.forRound(round.roundId).map((s) => s.band))
    expect(bands.has('top')).toBe(true)
  })

  test('enforces the agent timeout even when the runner ignores it', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, hangingRunner: true })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const subs = repos.submissions.forRound(round.roundId)
    expect(subs.every((s) => s.status === 'timeout')).toBe(true)
  })

  test('rejects a roster whose counts do not sum to populationSize', () => {
    const { engine } = makeMockEngine({ seed: 1, populationSize: 4, rosterMismatch: true })
    expect(() => engine.createRun('t', 'goal')).toThrow(/populationSize/i)
  })

  test('an agent is excluded from its own top performers list', async () => {
    const { engine, reflector } = makeMockEngine({ seed: 1, populationSize: 6 })
    const run = engine.createRun('t', 'goal')

    // Spy on the actual calls the driver makes to Reflector.reflect, so the
    // assertion is about what reflection was actually shown rather than a
    // downstream side effect that could hold for unrelated reasons.
    const reflectSpy = vi.spyOn(reflector, 'reflect')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    // Sanity check the spy actually observed calls — otherwise the assertion
    // below would vacuously pass with zero iterations.
    expect(reflectSpy).toHaveBeenCalled()

    for (const [req] of reflectSpy.mock.calls) {
      // TopPerformer carries rank/strategy/excerpt/rationale but no agent id.
      // Ranks are unique within a round, so a call whose own rank shows up
      // inside its own topPerformers list was handed itself as a leader to
      // imitate. Key on rank, not strategy text: clone agents legitimately
      // share identical strategy text, so a text comparison would produce
      // false positives (or mask a real self-inclusion bug).
      const selfRank = req.ownRank
      const sawSelf = req.topPerformers.some((tp) => tp.rank === selfRank)
      expect(sawSelf).toBe(false)
    }
  })
})
