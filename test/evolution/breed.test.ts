import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { breed } from '../../src/evolution/breed.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const setup = (n: number) => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'r', config: DEFAULT_CONFIG, seedDir: null })
  const agents = Array.from({ length: n }, (_, i) => {
    const a = repos.agents.create({
      runId: run.id, label: `c${i + 1}`, parentAgentId: null, bornRound: 1,
    })
    repos.genomes.create({
      agentId: a.id, roundIdx: 1, strategyMd: `strategy ${i}`, notesMd: '',
      modelId: 'm', temperature: 0.7, parentGenomeId: null, origin: 'seed',
    })
    return a
  })
  return { repos, run, agents }
}

describe('breed', () => {
  test('preserves the elite strategy verbatim', async () => {
    const { repos, run, agents } = setup(5)
    const plan = { elite: [agents[0]!.id], survivors: [agents[1]!.id, agents[2]!.id, agents[3]!.id], culled: [agents[4]!.id], clones: [{ parentAgentId: agents[0]!.id, replacesAgentId: agents[4]!.id }] }
    await breed({
      repos, runId: run.id, nextRoundIdx: 2, plan,
      mutated: new Map([
        [agents[1]!.id, { strategyMd: 'mutated 1', notesMd: '', modelId: 'm', temperature: 0.7 }],
        [agents[2]!.id, { strategyMd: 'mutated 2', notesMd: '', modelId: 'm', temperature: 0.7 }],
        [agents[3]!.id, { strategyMd: 'mutated 3', notesMd: '', modelId: 'm', temperature: 0.7 }],
      ]),
    })
    expect(repos.genomes.forRound(agents[0]!.id, 2)?.strategyMd).toBe('strategy 0')
    expect(repos.genomes.forRound(agents[0]!.id, 2)?.origin).toBe('elite')
  })

  test('applies mutated genomes to survivors', async () => {
    const { repos, run, agents } = setup(5)
    const plan = { elite: [agents[0]!.id], survivors: [agents[1]!.id], culled: [], clones: [] }
    await breed({
      repos, runId: run.id, nextRoundIdx: 2, plan,
      mutated: new Map([[agents[1]!.id, { strategyMd: 'evolved', notesMd: 'n', modelId: 'm', temperature: 0.8 }]]),
    })
    const g = repos.genomes.forRound(agents[1]!.id, 2)
    expect(g?.strategyMd).toBe('evolved')
    expect(g?.origin).toBe('mutation')
  })

  test('culls agents and creates replacements, keeping population constant', async () => {
    const { repos, run, agents } = setup(5)
    const plan = { elite: [agents[0]!.id], survivors: [agents[1]!.id, agents[2]!.id, agents[3]!.id], culled: [agents[4]!.id], clones: [{ parentAgentId: agents[0]!.id, replacesAgentId: agents[4]!.id }] }
    await breed({
      repos, runId: run.id, nextRoundIdx: 2, plan,
      mutated: new Map(agents.slice(1, 4).map((a) => [a.id, { strategyMd: 'm', notesMd: '', modelId: 'm', temperature: 0.7 }])),
    })
    expect(repos.agents.listActive(run.id)).toHaveLength(5)
    expect(repos.agents.listActive(run.id).map((a) => a.id)).not.toContain(agents[4]!.id)
  })

  test('clones inherit the parent strategy and record parentage', async () => {
    const { repos, run, agents } = setup(5)
    const plan = { elite: [agents[0]!.id], survivors: [agents[1]!.id, agents[2]!.id, agents[3]!.id], culled: [agents[4]!.id], clones: [{ parentAgentId: agents[0]!.id, replacesAgentId: agents[4]!.id }] }
    await breed({
      repos, runId: run.id, nextRoundIdx: 2, plan,
      mutated: new Map(agents.slice(1, 4).map((a) => [a.id, { strategyMd: 'm', notesMd: '', modelId: 'm', temperature: 0.7 }])),
    })
    const active = repos.agents.listActive(run.id)
    const child = active.find((a) => a.parentAgentId === agents[0]!.id)!
    expect(child).toBeDefined()
    expect(child.bornRound).toBe(2)
    expect(repos.genomes.forRound(child.id, 2)?.strategyMd).toBe('strategy 0')
    expect(repos.genomes.forRound(child.id, 2)?.origin).toBe('clone')
  })
})
