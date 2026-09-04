import { describe, expect, test, vi } from 'vitest'
import { makeMockEngine, SABOTAGED_TEXT } from '../helpers/mock-engine.js'
import { parseGenome } from '../../src/core/genome.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'

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

  test('a mid-round user criteria override wins over the POST body', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('test', 'goal')
    // Simulate the override endpoint landing after the round row exists but before
    // JUDGE resolves: hook the judging transition and write user criteria first.
    const setStatus = repos.rounds.setStatus.bind(repos.rounds)
    const hook = vi.spyOn(repos.rounds, 'setStatus').mockImplementation((id, status) => {
      setStatus(id, status)
      if (status === 'judging') repos.rounds.setCriteria(id, 'row rules', 'user')
    })
    const scoreSpy = vi.spyOn(Judge.prototype, 'score')
    try {
      const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      expect(scoreSpy).toHaveBeenCalled()
      expect(scoreSpy.mock.calls[0]![1]).toBe('row rules')
      const r = repos.rounds.get(round.roundId)!
      expect(r.criteriaMd).toBe('row rules')
      expect(r.criteriaSource).toBe('user')
    } finally {
      hook.mockRestore()
      scoreSpy.mockRestore()
    }
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
      // share identical strategy text, and a text comparison would
      // produce false positives (or mask a real self-inclusion bug).
      const selfRank = req.ownRank
      const sawSelf = req.topPerformers.some((tp) => tp.rank === selfRank)
      expect(sawSelf).toBe(false)
    }
  })

  test('reconfigure swaps in the new judge and new caps for the next round', async () => {
    const { engine, config } = makeMockEngine({ seed: 1, populationSize: 2 })
    const run = engine.createRun('t', 'goal')

    // A different provider/judge plus a run-token cap a single round will blow.
    const newProvider = new MockProvider(7)
    const newConfig = {
      ...config,
      judge: { ...config.judge, modelId: 'new/judge' },
      budget: { ...config.budget, maxRunTokens: 1000 },
    }
    const newJudge = new Judge(newProvider, newConfig.judge, 1)
    const judgeSpy = vi.spyOn(newProvider, 'complete')
    engine.reconfigure(run.id, {
      config: newConfig,
      judge: newJudge,
      reflector: new Reflector(newProvider, config.reflect, ['mock/model']),
    })

    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    // The new judge is the one that ran (the old provider would never be spied).
    expect(judgeSpy).toHaveBeenCalled()
    // The new cap is what the budget enforced.
    expect(round.budgetBreach).not.toBeNull()
    expect(round.budgetBreach!.reason).toMatch(/run token/i)
  })

  test('reconfigure rejects a run that was never created', () => {
    const { engine, config } = makeMockEngine({ seed: 1, populationSize: 2 })
    expect(() =>
      engine.reconfigure('nope', { config, judge: {} as never, reflector: {} as never }),
    ).toThrow(/createRun first/)
  })
})

describe('driver sandbox lifecycle', () => {
  test('tears down every agent workspace when the run is disposed', async () => {
    const { engine, repos, sandbox } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    await engine.dispose(run.id)
    const agents = repos.agents.listActive(run.id)
    const h = { agentId: agents[0]!.id, workspacePath: '', baseUrl: '' }
    await expect(sandbox.readFile(h as never, 'GOAL.md')).rejects.toThrow(/torn down/i)
  })

  test('a provisioning failure does not abort the round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, failProvisionFor: 1 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const scores = repos.scores.forRound(round.roundId)
    expect(scores).toHaveLength(4)
    expect(scores.filter((s) => s.score === 0).length).toBeGreaterThanOrEqual(1)
  })
})

describe('driver capture guardrails', () => {
  test('an agent exceeding the workspace quota is scored zero', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, floodFilesFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const subs = repos.submissions.forRound(round.roundId)
    const flooded = subs.find((s) => s.status === 'error' && /limit/i.test(s.errorText ?? ''))
    expect(flooded).toBeDefined()

    const score = repos.scores.forRound(round.roundId).find((s) => s.agentId === flooded!.agentId)
    expect(score?.score).toBe(0)
  })

  test('the round completes despite a quota violation', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, floodFilesFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })

  test('an agent within the quota is judged normally', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, floodFilesFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const subs = repos.submissions.forRound(round.roundId)
    expect(subs.filter((s) => s.status === 'ok')).toHaveLength(2)
  })

  // The window this closes: a rival sharing the container overwrites a workspace after
  // its owner has finished. The substituted text must never become the judged artifact.
  test('a rival cannot get a substituted submission judged', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, sabotageBy: 1 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const victim = repos.agents.listActive(run.id)[0]!
    const sub = repos.submissions.forRound(round.roundId).find((s) => s.agentId === victim.id)!
    expect(sub.submissionMd).not.toBe(SABOTAGED_TEXT)
    expect(sub.submissionMd).toContain('Approach:')
  })

  test('the substitution is recorded as a tamper event against the victim', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, sabotageBy: 1 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const victim = repos.agents.listActive(run.id)[0]!
    const events = repos.events
      .forRun(run.id)
      .filter((e) => e.type === 'submission.tampered' && e.agentId === victim.id)
    expect(events).toHaveLength(1)
    expect(events[0]!.payload.detail).toMatch(/modified/i)
    // Every agent was confirmed stopped before COLLECT re-read the workspace, so the
    // verdict is a finding rather than an observation that might already be stale.
    expect(events[0]!.payload.verified).toBe(true)
  })

  test('an untampered agent produces no tamper event', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, sabotageBy: 1 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const saboteur = repos.agents.listActive(run.id)[1]!
    const events = repos.events
      .forRun(run.id)
      .filter((e) => e.type === 'submission.tampered' && e.agentId === saboteur.id)
    expect(events).toHaveLength(0)
  })

  // If any agent in the round could not be confirmed stopped, a co-tenant may still be
  // writing, so nothing captured that round can honestly be called verified.
  test('nothing is certified when an agent cannot be confirmed stopped', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1,
      populationSize: 3,
      sabotageBy: 1,
      unstoppableSaboteur: true,
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const victim = repos.agents.listActive(run.id)[0]!
    const event = repos.events
      .forRun(run.id)
      .find((e) => e.type === 'submission.tampered' && e.agentId === victim.id)!
    expect(event.payload.detail).toMatch(/modified/i)
    expect(event.payload.verified).toBe(false)
  })

  // Amendment (A). The window the earlier design left open: the substitution lands
  // BEFORE the orchestrator's read, so the bytes on record are already the rival's and
  // every later re-read agrees with them. Nothing host-side can recover the victim's
  // text here — what must never happen is the system stamping the rival's file as the
  // victim's own verified work.
  test('a substitution during the capture read cannot be certified as intact', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1,
      populationSize: 3,
      sabotageDuringCapture: true,
    })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const victim = repos.agents.listActive(run.id)[0]!
    const sub = repos.submissions.forRound(round.roundId).find((s) => s.agentId === victim.id)!
    // The rival's text did land — this is the irreducible part.
    expect(sub.submissionMd).toBe(SABOTAGED_TEXT)

    const event = repos.events
      .forRun(run.id)
      .find((e) => e.type === 'submission.captured' && e.agentId === victim.id)!
    // Every agent stopped and every file hashed, so the ONLY thing standing between the
    // rival's file and a clean bill of health is the capture being unsealed.
    expect(event.payload.tampered).toBe(false)
    expect(event.payload.sealed).toBe(false)
    expect(event.payload.verified).toBe(false)
  })

  test('a shared workspace is never sealed, however cleanly the round ran', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const captured = repos.events.forRun(run.id).filter((e) => e.type === 'submission.captured')
    expect(captured).toHaveLength(3)
    for (const e of captured) expect(e.payload.verified).toBe(false)
  })

  // The other side of the same rule: give an agent a workspace nobody else can reach and
  // the capture becomes certifiable, so the flag is a real distinction and not a
  // constant `false` dressed up as a safety property.
  test('an isolated workspace yields a sealed, verified-intact capture', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1,
      populationSize: 3,
      isolatedWorkspaces: true,
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const captured = repos.events.forRun(run.id).filter((e) => e.type === 'submission.captured')
    expect(captured).toHaveLength(3)
    for (const e of captured) {
      expect(e.payload.sealed).toBe(true)
      expect(e.payload.tampered).toBe(false)
      expect(e.payload.verified).toBe(true)
    }
  })
})

describe('driver budget enforcement', () => {
  test('a round that breaches the budget still completes, and the breach is reported', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, hugeTokensFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
    expect(round.budgetBreach).not.toBeNull()
    expect(round.budgetBreach?.reason).toMatch(/token/i)

    // The rest of the round still ran: every agent was scored, including the one that
    // blew the budget — that work is paid for either way.
    expect(repos.scores.forRound(round.roundId)).toHaveLength(4)
  })

  test('reflection is skipped once the round breaches budget, so survivor genomes carry forward unchanged', async () => {
    const { engine, repos, reflector } = makeMockEngine({ seed: 1, populationSize: 4, hugeTokensFor: 0 })
    const run = engine.createRun('t', 'goal')
    const reflectSpy = vi.spyOn(reflector, 'reflect')

    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(round.budgetBreach).not.toBeNull()
    expect(reflectSpy).not.toHaveBeenCalled()

    // Rank 2 is a survivor (population 4: 1 elite, 0 culled at these selection
    // defaults), so under normal operation reflection would be free to mutate it.
    const survivor = repos.scores.forRound(round.roundId).find((s) => s.rank === 2)!
    const before = repos.genomes.forRound(survivor.agentId, round.roundIdx)!
    const after = repos.genomes.forRound(survivor.agentId, round.roundIdx + 1)!
    expect(after.strategyMd).toBe(before.strategyMd)
    expect(after.notesMd).toBe(before.notesMd)
    expect(after.modelId).toBe(before.modelId)
    expect(after.temperature).toBe(before.temperature)
  })

  test('a run under budget behaves exactly as before', async () => {
    const { engine, repos, reflector } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    const reflectSpy = vi.spyOn(reflector, 'reflect')

    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(round.budgetBreach).toBeNull()
    expect(reflectSpy).toHaveBeenCalled()
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
    expect(repos.scores.forRound(round.roundId)).toHaveLength(4)
  })

  // makeMockEngine forces concurrency to 1 whenever hugeTokensFor is set, so agent 0
  // (the one carrying the marker) is guaranteed to run and record BEFORE the pool ever
  // pulls agents 1-3 off the queue — making "later agents were never dispatched" a fact
  // instead of a race. This is the guardrail the isolation tests warn a project like
  // this one can ship plumbed but mute: `shouldStopDispatch` exists and is called, but
  // nothing proves it ever actually stops a dispatch without a test shaped like this one.
  test('shouldStopDispatch stops agents still queued once an earlier one blows the budget', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, hugeTokensFor: 0 })
    const run = engine.createRun('t', 'goal')
    const agents = repos.agents.listActive(run.id)
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const subs = repos.submissions.forRound(round.roundId)
    const byAgent = new Map(subs.map((s) => [s.agentId, s]))

    // Agent 0 actually ran (it is the one that blew the budget, not a casualty of it).
    const first = byAgent.get(agents[0]!.id)!
    expect(first.status).toBe('ok')
    expect(first.tokensIn).toBe(2_000_000)

    // Agents 1-3 were still queued when agent 0's usage tripped the round cap, so the
    // pool must never have called the runner for them at all.
    for (const agent of agents.slice(1)) {
      const sub = byAgent.get(agent.id)!
      expect(sub.status).toBe('error')
      expect(sub.errorText).toMatch(/dispatch skipped/i)
      expect(sub.tokensIn).toBe(0)
    }
  })
})

describe('driver event emission', () => {
  test('emits round status transitions in lifecycle order', async () => {
    const seen: string[] = []
    const { engine, } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => { if (e.type === 'round.status') seen.push(e.status) },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(seen).toContain('running')
    expect(seen).toContain('judging')
    expect(seen.at(-1)).toBe('complete')
  })

  test('emits a status per agent, ending in done or failed', async () => {
    const byAgent = new Map<string, string[]>()
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => {
        if (e.type === 'agent.status') {
          byAgent.set(e.agentId, [...(byAgent.get(e.agentId) ?? []), e.status])
        }
      },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(byAgent.size).toBe(4)
    for (const statuses of byAgent.values()) {
      expect(statuses).toContain('running')
      expect(['done', 'failed']).toContain(statuses.at(-1))
    }
  })

  test('emits scores once judging completes', async () => {
    let scored: { agentId: string; rank: number }[] = []
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => { if (e.type === 'round.scored') scored = e.scores },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(scored).toHaveLength(4)
    expect(scored.map((s) => s.rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  test('a subscriber that throws does not fail the round', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1, populationSize: 3,
      onEvent: () => { throw new Error('subscriber exploded') },
    })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })

  test('emits nothing when no sink is provided', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })
})
