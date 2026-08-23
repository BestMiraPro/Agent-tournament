import { describe, expect, test } from 'vitest'
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
