import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { AuditCollector } from '../../src/engine/audit.js'
import { parseChannel } from '../../src/engine/channel.js'
import { TournamentEngine, type EngineDeps } from '../../src/engine/driver.js'
import type { EngineEvent } from '../../src/engine/events.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { Judge } from '../../src/judge/judge.js'
import { MockAgentRunner, type AgentRunner } from '../../src/runtime/agent-runner.js'
import { GOOD_KEYWORDS, MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import type { Sandbox } from '../../src/runtime/sandbox.js'

const FAST_CHANNEL = { pollMs: 5, minGapMs: 0 }

function makeTeam(opts: {
  population?: number
  config?: Partial<RunConfig>
  wrapRunner?: (inner: MockAgentRunner, sandbox: MockSandbox, engine: () => TournamentEngine) => AgentRunner
  sandbox?: Sandbox
  seedStrategy?: (i: number) => string
  deps?: Partial<EngineDeps>
} = {}) {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const population = opts.population ?? 3
  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    workflow: 'collaboration',
    populationSize: population,
    sandbox: 'mock',
    roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    ...opts.config,
  }
  const sandbox = new MockSandbox({ seedFiles: { 'data/seed.csv': 'a,b\n1,2' } })
  const provider = new MockProvider(7)
  const mock = new MockAgentRunner(sandbox, 7)
  const events: EngineEvent[] = []
  let engine!: TournamentEngine
  const runner = opts.wrapRunner ? opts.wrapRunner(mock, sandbox, () => engine) : mock
  engine = new TournamentEngine({
    repos, config,
    sandbox: opts.sandbox ?? sandbox,
    runner,
    judge: new Judge(provider, config.judge, 7),
    reflector: new Reflector(provider, config.reflect, ['mock/model']),
    seedStrategy: opts.seedStrategy ?? ((i) => `work on ${GOOD_KEYWORDS[i % GOOD_KEYWORDS.length]}`),
    onEvent: (e) => events.push(e),
    audit: new AuditCollector(repos, { provenance: { sandbox: 'mock', isolation: null, toolchainId: null } }),
    channel: FAST_CHANNEL,
    ...opts.deps,
  })
  return { db, repos, engine, sandbox, mock, events, config }
}

describe('a collaboration round', () => {
  test('one team, one shared folder, a channel they talk through, and one sealed artifact judged once', async () => {
    const t = makeTeam()
    const run = t.engine.createRun('team', 'write a study')
    const agents = t.repos.agents.listActive(run.id)
    expect(agents.map((a) => a.label)).toEqual(['agent-01', 'agent-02', 'agent-03'])
    const r = await t.engine.runRound(run.id, { goalMd: 'write a study', criteriaMd: null })

    // The channel: every member introduced itself and said when it was done; the lead wrote the README.
    const channel = t.repos.channel.forRound(r.roundId)
    expect(channel.filter((m) => m.body.includes('here. My focus')).map((m) => m.author).sort()).toEqual(['agent-01', 'agent-02', 'agent-03'])
    expect(channel.filter((m) => m.body.startsWith('done: wrote')).length).toBe(3)
    expect(channel.some((m) => m.author === 'agent-01' && m.body.startsWith('README written: 3 piece(s)'))).toBe(true)
    expect(channel.every((m) => m.agentId !== null)).toBe(true)
    // Posts reached teammates' sessions, never their author's.
    for (const a of agents) {
      const inbox = (t.mock.inbox.get(a.id) ?? []).join('\n')
      expect(inbox).toContain('New on the team channel')
      expect(inbox).not.toContain(`### ${a.label} ·`)
    }
    expect(channel.find((m) => m.author === 'agent-01')!.deliveredTo.length).toBeGreaterThan(0)
    expect(t.events.filter((e) => e.type === 'channel.message')).toHaveLength(channel.length)

    // The artifact: sealed after every member stopped, with the README and every piece stored.
    const out = t.repos.teamOutputs.get(r.roundId)!
    expect(out).toMatchObject({ status: 'ok', sealed: true, hashesComplete: true, fileCount: 4 })
    expect(out.files.map((f) => f.path)).toEqual(['output/README.md', 'output/agent-01.md', 'output/agent-02.md', 'output/agent-03.md'])
    expect(out.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(t.repos.teamOutputs.file(r.roundId, 'output/README.md')).toContain('Pieces:')
    expect(parseChannel(out.channelMd!)).toHaveLength(channel.length)

    // One team score, mirrored into every member's row; no bands, nobody culled.
    const team = t.repos.teamScores.forRound(r.roundId)!
    expect(team.status).toBe('ok')
    expect(team.score).toBeGreaterThan(0)
    expect(t.repos.scores.forRound(r.roundId).map((s) => [s.rank, s.score, s.band])).toEqual(agents.map(() => [1, team.score, null]))
    const scored = t.events.find((e) => e.type === 'round.scored')
    expect(scored).toMatchObject({ team: { score: team.score, status: 'ok' } })
    const envelope = t.repos.judgingAudits.forRound(r.roundId)[0]!.payload as { agents: Record<string, { scoreDerivation: string }>; calls: { prompt: string; stage: string }[] }
    expect(Object.keys(envelope.agents).sort()).toEqual(agents.map((a) => a.id).sort())
    expect(Object.values(envelope.agents).every((a) => a.scoreDerivation === 'model_awarded')).toBe(true)
    const judgeCall = envelope.calls.find((c) => c.stage === 'single')!
    expect(judgeCall.prompt).toContain('<submission ref="TEAM">')
    expect(judgeCall.prompt).toContain('<activity ref="M3">')
    expect(judgeCall.prompt).not.toContain('<submission ref="S1">')

    // Reflection only: every member has a next-round genome, the population is unchanged.
    expect(t.repos.agents.listActive(run.id)).toHaveLength(3)
    expect(t.repos.agents.listAll(run.id)).toHaveLength(3)
    for (const a of agents) expect(t.repos.genomes.forRound(a.id, 2)?.origin).toBe('mutation')
    expect(t.repos.submissions.forRound(r.roundId).every((s) => s.status === 'ok' && s.submissionMd === null)).toBe(true)
    expect(t.repos.rounds.get(r.roundId)!.status).toBe('complete')
  })

  test('the workspace carries over: round 2 builds on round 1, and only its own channel entries are its record', async () => {
    const t = makeTeam({
      population: 2,
      wrapRunner: (inner, sandbox) => ({
        ...inner,
        run: async (h, c) => {
          const res = await inner.run(h, c)
          if (c.team?.label === 'agent-02') await sandbox.writeFile(h, `output/round-${await roundOf(sandbox, h)}.txt`, 'kept')
          return res
        },
        abortAll: () => inner.abortAll(),
        quiesce: () => inner.quiesce(),
        send: (h, text) => inner.send(h, text),
      }),
    })
    const roundOf = async (sandbox: MockSandbox, h: Parameters<MockSandbox['readFile']>[0]) =>
      ((await sandbox.readFile(h, 'CHANNEL.md')) ?? '').match(/^## Round (\d+)$/gm)!.length
    const run = t.engine.createRun('team', 'g')
    const r1 = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    const r2 = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    const files2 = t.repos.teamOutputs.get(r2.roundId)!.files.map((f) => f.path)
    expect(files2).toContain('output/round-1.txt')
    expect(files2).toContain('output/round-2.txt')
    const ch1 = t.repos.channel.forRound(r1.roundId)
    const ch2 = t.repos.channel.forRound(r2.roundId)
    expect(ch2.length).toBe(ch1.length)
    expect(ch2[0]!.seq).toBe(1)
    // The file keeps both rounds for the team to read back.
    expect(parseChannel(t.repos.teamOutputs.get(r2.roundId)!.channelMd!)).toHaveLength(ch1.length + ch2.length)
  })

  test('the seed is copied once, and seeded files do not count against the team quota', async () => {
    const t = makeTeam({ population: 2, config: { seedDir: '/seed', maxWorkspaceFiles: 5 } })
    const run = t.engine.createRun('team', 'g')
    const r = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    // The mock workspace holds exactly 10 files of the team's (plumbing included: the mock lists
    // .opencode too) plus the seeded one, against a team cap of 2 x 5: only the exemption fits it.
    const [first] = t.repos.agents.listActive(run.id)
    const team = await t.sandbox.provisionTeam(run.id, [first!.id], { seedDir: '/seed' })
    expect(team.created).toBe(false)
    const files = await t.sandbox.listFiles(team.handles.get(first!.id)!)
    expect(files).toHaveLength(11)
    expect(files.filter((f) => f.path === 'data/seed.csv')).toHaveLength(1)
    expect(t.repos.teamOutputs.get(r.roundId)!.status).toBe('ok')
  })

  test('an empty output folder is not judged: the team scores 0 and its behaviour is still reviewed', async () => {
    const t = makeTeam({
      population: 2,
      wrapRunner: (inner) => ({
        run: async (_h, c) => ({ status: 'ok', errorText: null, tokensIn: 1, tokensOut: 1, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0, durationMs: 1, ...(c ? {} : {}) }),
        abortAll: () => inner.abortAll(),
        quiesce: async () => 'stopped',
      }),
    })
    const run = t.engine.createRun('team', 'g')
    const r = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    expect(t.repos.teamOutputs.get(r.roundId)).toMatchObject({ status: 'no_submission', fileCount: 0 })
    expect(t.repos.teamScores.forRound(r.roundId)).toMatchObject({ score: 0, status: 'no_submission' })
    const envelope = t.repos.judgingAudits.forRound(r.roundId)[0]!.payload as { agents: Record<string, { scoreDerivation: string; limitations: string[] }>; calls: { stage: string }[] }
    expect(Object.values(envelope.agents).every((a) => a.scoreDerivation === 'not_judged')).toBe(true)
    expect(envelope.calls.some((c) => c.stage === 'safety')).toBe(true)
    expect(envelope.calls.some((c) => c.stage === 'single')).toBe(false)
  })

  test('a team over its quota gets an error result naming the cap', async () => {
    const t = makeTeam({
      population: 2,
      config: { maxWorkspaceFiles: 5 },
      wrapRunner: (inner, sandbox) => ({
        ...inner,
        run: async (h, c) => {
          const res = await inner.run(h, c)
          for (let i = 0; i < 12; i++) await sandbox.writeFile(h, `junk/${c.agentId}-${i}`, 'x')
          return res
        },
        abortAll: () => inner.abortAll(),
        quiesce: () => inner.quiesce(),
        send: (h, text) => inner.send(h, text),
      }),
    })
    const run = t.engine.createRun('team', 'g')
    const r = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    const out = t.repos.teamOutputs.get(r.roundId)!
    expect(out.status).toBe('error')
    expect(out.errorText).toMatch(/team workspace holds \d+ files, limit is 10/)
    expect(t.repos.teamScores.forRound(r.roundId)!.score).toBe(0)
  })

  test('a member that cannot be confirmed stopped leaves the snapshot unsealed', async () => {
    const t = makeTeam({
      population: 2,
      wrapRunner: (inner) => ({ run: (h, c) => inner.run(h, c), abortAll: () => inner.abortAll(), send: (h, text) => inner.send(h, text) }),
    })
    const run = t.engine.createRun('team', 'g')
    const r = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    expect(t.repos.teamOutputs.get(r.roundId)!.sealed).toBe(false)
  })

  test('file contributions come from each member\'s own activity, posts from the channel', async () => {
    const t = makeTeam({
      population: 2,
      wrapRunner: (inner, _sandbox, engine) => ({
        ...inner,
        run: async (h, c) => {
          engine().observe({
            type: 'agent.activity', runId: [...engineRuns][0]!, agentId: c.agentId, kind: 'tool', detail: 'write',
            item: { id: `w-${c.agentId}`, sessionId: '', kind: 'tool', status: 'completed', summary: `write: ${h.workspacePath}/output/${c.team!.label}-notes.md`, observedAt: Date.now() },
          })
          return inner.run(h, c)
        },
        abortAll: () => inner.abortAll(),
        quiesce: () => inner.quiesce(),
        send: (h, text) => inner.send(h, text),
      }),
    })
    const engineRuns = new Set<string>()
    const run = t.engine.createRun('team', 'g')
    engineRuns.add(run.id)
    const r = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    const contributions = t.repos.teamOutputs.get(r.roundId)!.contributions
    const byLabel = Object.fromEntries(Object.values(contributions).map((c) => [c.label, c]))
    expect(byLabel['agent-01']).toMatchObject({ files: ['output/agent-01-notes.md'], toolCalls: 1 })
    expect(byLabel['agent-02']!.files).toEqual(['output/agent-02-notes.md'])
    expect(byLabel['agent-01']!.posts).toBeGreaterThanOrEqual(2)
  })

  test('the grader is pointed at the sealed copy when the composition can write one', async () => {
    const written: { roundId: string; paths: string[] }[] = []
    const t = makeTeam({
      population: 2,
      deps: {
        sealedArtifacts: {
          write: async (roundId, files) => {
            written.push({ roundId, paths: files.map((f) => f.path) })
            return `/grader/sealed/${roundId}/output`
          },
        },
      },
    })
    const run = t.engine.createRun('team', 'g')
    const r = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    expect(written).toEqual([{ roundId: r.roundId, paths: ['output/README.md', 'output/agent-01.md', 'output/agent-02.md'] }])
    const envelope = t.repos.judgingAudits.forRound(r.roundId)[0]!.payload as { calls: { prompt: string; stage: string }[] }
    const prompt = envelope.calls.find((c) => c.stage === 'single')!.prompt
    expect(prompt).toContain(`The team's sealed output folder is at /grader/sealed/${r.roundId}/output.`)
    expect(prompt).not.toContain('--- output/agent-01.md ---')
  })

  test('a budget breach skips reflection: strategies carry forward unchanged', async () => {
    const t = makeTeam({ population: 2, config: { budget: { ...DEFAULT_CONFIG.budget, maxRoundTokens: 10 } } })
    const run = t.engine.createRun('team', 'g')
    const reflect = vi.spyOn(Reflector.prototype, 'reflectTeam')
    const r = await t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    expect(r.budgetBreach).not.toBeNull()
    expect(reflect).not.toHaveBeenCalled()
    for (const a of t.repos.agents.listActive(run.id)) {
      const g1 = t.repos.genomes.forRound(a.id, 1)!
      const g2 = t.repos.genomes.forRound(a.id, 2)!
      expect([g2.origin, g2.strategyMd, g2.parentGenomeId]).toEqual(['clone', g1.strategyMd, g1.id])
    }
    reflect.mockRestore()
  })

  test('a sandbox with no team workspace is refused before the round exists', async () => {
    const plain = new MockSandbox()
    const noTeam: Sandbox = {
      provision: (id, o) => plain.provision(id, o), reset: (h, o) => plain.reset(h, o), writeFile: (h, p, c) => plain.writeFile(h, p, c),
      readFile: (h, p) => plain.readFile(h, p), listFiles: (h) => plain.listFiles(h), endpoint: (h) => plain.endpoint(h), teardown: (h) => plain.teardown(h),
    }
    const t = makeTeam({ sandbox: noTeam })
    const run = t.engine.createRun('team', 'g')
    await expect(t.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })).rejects.toThrow(/cannot run collaboration rounds/)
    expect(t.repos.rounds.lastIdx(run.id)).toBe(0)
  })
})
