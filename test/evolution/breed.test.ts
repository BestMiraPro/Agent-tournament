import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { breed, type RecombineFn } from '../../src/evolution/breed.js'
import { buildRecombinePrompt, recombineStrategies } from '../../src/evolution/recombine.js'
import type { Provider } from '../../src/runtime/provider.js'
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
    const plan = { elite: [agents[0]!.id], survivors: [agents[1]!.id, agents[2]!.id, agents[3]!.id], culled: [agents[4]!.id], clones: [{ parentAgentId: agents[0]!.id, replacesAgentId: agents[4]!.id }], crossovers: [], rescued: [] as string[] }
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
    const plan = { elite: [agents[0]!.id], survivors: [agents[1]!.id], culled: [], clones: [], crossovers: [], rescued: [] as string[] }
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
    const plan = { elite: [agents[0]!.id], survivors: [agents[1]!.id, agents[2]!.id, agents[3]!.id], culled: [agents[4]!.id], clones: [{ parentAgentId: agents[0]!.id, replacesAgentId: agents[4]!.id }], crossovers: [], rescued: [] as string[] }
    await breed({
      repos, runId: run.id, nextRoundIdx: 2, plan,
      mutated: new Map(agents.slice(1, 4).map((a) => [a.id, { strategyMd: 'm', notesMd: '', modelId: 'm', temperature: 0.7 }])),
    })
    expect(repos.agents.listActive(run.id)).toHaveLength(5)
    expect(repos.agents.listActive(run.id).map((a) => a.id)).not.toContain(agents[4]!.id)
  })

  test('clones inherit the parent strategy and record parentage', async () => {
    const { repos, run, agents } = setup(5)
    const plan = { elite: [agents[0]!.id], survivors: [agents[1]!.id, agents[2]!.id, agents[3]!.id], culled: [agents[4]!.id], clones: [{ parentAgentId: agents[0]!.id, replacesAgentId: agents[4]!.id }], crossovers: [], rescued: [] as string[] }
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

describe('breed crossover', () => {
  const setupPair = (strategyA: string, notesA: string, strategyB: string) => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const run = repos.runs.create({ name: 'r', config: DEFAULT_CONFIG, seedDir: null })
    const mk = (label: string, strategyMd: string, notesMd: string, modelId: string, temperature: number) => {
      const a = repos.agents.create({ runId: run.id, label, parentAgentId: null, bornRound: 1 })
      const g = repos.genomes.create({
        agentId: a.id, roundIdx: 1, strategyMd, notesMd,
        modelId, temperature, parentGenomeId: null, origin: 'seed',
      })
      return { a, g }
    }
    const A = mk('alpha', strategyA, notesA, 'mA', 0.9)
    const B = mk('beta', strategyB, 'notes-b', 'mB', 0.3)
    const mkVictim = (label: string) => {
      const a = repos.agents.create({ runId: run.id, label, parentAgentId: null, bornRound: 1 })
      repos.genomes.create({
        agentId: a.id, roundIdx: 1, strategyMd: 'v', notesMd: '',
        modelId: 'mB', temperature: 0.3, parentGenomeId: null, origin: 'seed',
      })
      return a
    }
    return { repos, run, A, B, mkVictim }
  }

  const crossoverPlan = (ids: { A: string; B: string; victim: string }, clones: { parentAgentId: string; replacesAgentId: string }[] = [], victim2?: string) => ({
    elite: [] as string[],
    survivors: [] as string[],
    culled: victim2 ? [ids.victim, victim2] : [ids.victim],
    clones,
    crossovers: [{ parentAId: ids.A, parentBId: ids.B, replacesAgentId: ids.victim }],
    rescued: [] as string[],
  })

  test('merges an even line count: first half of A plus last half of B', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2\na3\na4', 'notes-a\n', 'b1\nb2\nb3\nb4')
    const victim = mkVictim('doomed')
    await breed({
      repos, runId: run.id, nextRoundIdx: 2,
      plan: crossoverPlan({ A: A.a.id, B: B.a.id, victim: victim.id }),
      mutated: new Map(),
    })
    const child = repos.agents.listActive(run.id).find((a) => a.parentAgentId === A.a.id)!
    expect(repos.genomes.forRound(child.id, 2)?.strategyMd).toBe('a1\na2\nb3\nb4')
  })

  test('merges an odd line count: the extra line goes to A', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2\na3', 'notes-a\n', 'b1\nb2\nb3')
    const victim = mkVictim('doomed')
    await breed({
      repos, runId: run.id, nextRoundIdx: 2,
      plan: crossoverPlan({ A: A.a.id, B: B.a.id, victim: victim.id }),
      mutated: new Map(),
    })
    const child = repos.agents.listActive(run.id).find((a) => a.parentAgentId === A.a.id)!
    expect(repos.genomes.forRound(child.id, 2)?.strategyMd).toBe('a1\na2\nb3')
  })

  test('records provenance, origin, and parentage from A', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2', 'notes-a\n', 'b1\nb2')
    const victim = mkVictim('doomed')
    await breed({
      repos, runId: run.id, nextRoundIdx: 2,
      plan: crossoverPlan({ A: A.a.id, B: B.a.id, victim: victim.id }),
      mutated: new Map(),
    })
    const child = repos.agents.listActive(run.id).find((a) => a.parentAgentId === A.a.id)!
    const g = repos.genomes.forRound(child.id, 2)!
    expect(g.origin).toBe('crossover')
    expect(g.notesMd).toBe('Crossover of alpha × beta.\nnotes-a\n')
    expect(g.modelId).toBe('mA')
    expect(g.temperature).toBe(0.9)
    expect(g.parentGenomeId).toBe(A.g.id)
    expect(child.bornRound).toBe(2)
  })

  test('child labels stay unique against a clone in the same plan', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2', 'notes-a\n', 'b1\nb2')
    const v1 = mkVictim('doomed-1')
    const v2 = mkVictim('doomed-2')
    await breed({
      repos, runId: run.id, nextRoundIdx: 2,
      plan: crossoverPlan(
        { A: A.a.id, B: B.a.id, victim: v1.id },
        [{ parentAgentId: B.a.id, replacesAgentId: v2.id }],
        v2.id,
      ),
      mutated: new Map(),
    })
    const children = repos.agents.listActive(run.id).filter((a) => a.label.startsWith('competitor-r2-'))
    expect(children).toHaveLength(2)
    expect(new Set(children.map((a) => a.label)).size).toBe(2)
  })

  test('skips the crossover when either parent has no previous genome', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2', 'notes-a\n', 'b1\nb2')
    const before = repos.agents.listActive(run.id).length
    for (const ids of [
      { A: 'missing-a', B: B.a.id },
      { A: A.a.id, B: 'missing-b' },
    ]) {
      const victim = mkVictim(`doomed-${ids.A}`)
      await breed({
        repos, runId: run.id, nextRoundIdx: 2,
        plan: crossoverPlan({ ...ids, victim: victim.id }),
        mutated: new Map(),
      })
    }
    expect(repos.agents.listActive(run.id)).toHaveLength(before)
    expect(repos.agents.listActive(run.id).filter((a) => a.label.startsWith('competitor-r2-'))).toHaveLength(0)
  })

  test('uses recombined text verbatim on success, keeping the crossover provenance', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2', 'notes-a\n', 'b1\nb2')
    const victim = mkVictim('doomed')
    const seen: [string, string][] = []
    const recombine: RecombineFn = async (sa, sb) => {
      seen.push([sa, sb])
      return { strategyMd: 'recombined-s', notesMd: 'recombined-n' }
    }
    await breed({
      repos, runId: run.id, nextRoundIdx: 2,
      plan: crossoverPlan({ A: A.a.id, B: B.a.id, victim: victim.id }),
      mutated: new Map(),
      recombine,
    })
    // The seam receives both parents' strategies; the goal/model stay bound in
    // the caller's closure, so breed never sees them.
    expect(seen).toEqual([['a1\na2', 'b1\nb2']])
    const child = repos.agents.listActive(run.id).find((a) => a.parentAgentId === A.a.id)!
    const g = repos.genomes.forRound(child.id, 2)!
    expect(g.strategyMd).toBe('recombined-s')
    // Provenance is about lineage, not method: the exact 4d prefix on both paths.
    expect(g.notesMd).toBe('Crossover of alpha × beta.\nrecombined-n')
    expect(g.origin).toBe('crossover')
    expect(g.modelId).toBe('mA')
    expect(g.temperature).toBe(0.9)
    expect(g.parentGenomeId).toBe(A.g.id)
  })

  test('falls back to split-merge with the failure prefix when recombine throws', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2\na3\na4', 'notes-a\n', 'b1\nb2\nb3\nb4')
    const victim = mkVictim('doomed')
    await breed({
      repos, runId: run.id, nextRoundIdx: 2,
      plan: crossoverPlan({ A: A.a.id, B: B.a.id, victim: victim.id }),
      mutated: new Map(),
      recombine: async () => { throw new Error('provider boom') },
    })
    const child = repos.agents.listActive(run.id).find((a) => a.parentAgentId === A.a.id)!
    const g = repos.genomes.forRound(child.id, 2)!
    expect(g.strategyMd).toBe('a1\na2\nb3\nb4')
    expect(g.notesMd).toBe('Crossover of alpha × beta (recombine failed, split merge).\nnotes-a\n')
    expect(g.origin).toBe('crossover')
    expect(g.modelId).toBe('mA')
    expect(g.temperature).toBe(0.9)
    expect(g.parentGenomeId).toBe(A.g.id)
  })

  test('falls back to split-merge when recombine returns an empty strategy', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2', 'notes-a\n', 'b1\nb2')
    const victim = mkVictim('doomed')
    await breed({
      repos, runId: run.id, nextRoundIdx: 2,
      plan: crossoverPlan({ A: A.a.id, B: B.a.id, victim: victim.id }),
      mutated: new Map(),
      recombine: async () => ({ strategyMd: '   ', notesMd: 'nothing' }),
    })
    const child = repos.agents.listActive(run.id).find((a) => a.parentAgentId === A.a.id)!
    const g = repos.genomes.forRound(child.id, 2)!
    expect(g.strategyMd).toBe('a1\nb2')
    expect(g.notesMd).toBe('Crossover of alpha × beta (recombine failed, split merge).\nnotes-a\n')
  })

  test('makes zero recombine calls when the plan has no crossover slots', async () => {
    const { repos, run, A, B, mkVictim } = setupPair('a1\na2', 'notes-a\n', 'b1\nb2')
    const victim = mkVictim('doomed')
    let calls = 0
    await breed({
      repos, runId: run.id, nextRoundIdx: 2,
      plan: {
        elite: [] as string[], survivors: [] as string[], culled: [victim.id],
        clones: [], crossovers: [], rescued: [] as string[],
      },
      mutated: new Map(),
      recombine: async () => { calls++; return { strategyMd: 'x', notesMd: 'y' } },
    })
    // pct 0 yields no crossover slots, so the default path costs zero LLM calls.
    expect(calls).toBe(0)
  })
})

describe('recombineStrategies', () => {
  const fake = (replies: (string | Error)[]): { provider: Provider; calls: { prompt: string; modelId: string; purpose: string }[] } => {
    const calls: { prompt: string; modelId: string; purpose: string }[] = []
    return {
      calls,
      provider: {
        complete: async (req) => {
          calls.push({ prompt: req.prompt, modelId: req.modelId, purpose: req.purpose })
          const next = replies[Math.min(calls.length - 1, replies.length - 1)]!
          if (next instanceof Error) throw next
          return next
        },
      },
    }
  }

  test('sends both parents plus the goal as one structured call on the reflect model', async () => {
    const { provider, calls } = fake([JSON.stringify({ strategy_md: 's', notes_md: 'n' })])
    const out = await recombineStrategies(provider, 'reflect-model', 'strategy-A', 'strategy-B', 'the-goal')
    expect(out).toEqual({ strategyMd: 's', notesMd: 'n' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.purpose).toBe('reflect')
    expect(calls[0]!.modelId).toBe('reflect-model')
    expect(calls[0]!.prompt).toContain('strategy-A')
    expect(calls[0]!.prompt).toContain('strategy-B')
    expect(calls[0]!.prompt).toContain('the-goal')
    // The prompt builder is pure: the sent prompt is exactly what it builds.
    expect(calls[0]!.prompt).toBe(buildRecombinePrompt('strategy-A', 'strategy-B', 'the-goal'))
  })

  test('attempts one repair with the parse error, then uses the repaired reply', async () => {
    const { provider, calls } = fake([
      'not json at all',
      JSON.stringify({ strategy_md: 'repaired-s', notes_md: 'repaired-n' }),
    ])
    const out = await recombineStrategies(provider, 'm', 'a', 'b', 'goal')
    expect(out).toEqual({ strategyMd: 'repaired-s', notesMd: 'repaired-n' })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.prompt).toContain('failed to parse')
  })

  test('throws after the single repair attempt fails, so the caller falls back', async () => {
    const { provider, calls } = fake(['garbage', 'still garbage'])
    await expect(recombineStrategies(provider, 'm', 'a', 'b', 'goal')).rejects.toThrow()
    // Same retry budget as Reflector.reflect: one initial call plus one repair.
    expect(calls).toHaveLength(2)
  })

  test('throws when the provider throws, so the caller falls back', async () => {
    const { provider, calls } = fake([new Error('provider down')])
    await expect(recombineStrategies(provider, 'm', 'a', 'b', 'goal')).rejects.toThrow('provider down')
    expect(calls).toHaveLength(1)
  })
})
