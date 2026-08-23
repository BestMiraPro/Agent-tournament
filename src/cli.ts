import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, type RunConfig } from './core/types.js'
import { openDb } from './db/open.js'
import { makeRepos } from './db/repos.js'
import { TournamentEngine } from './engine/driver.js'
import { Reflector } from './evolution/reflect.js'
import { Judge } from './judge/judge.js'
import { MockAgentRunner } from './runtime/agent-runner.js'
import { GOOD_KEYWORDS, MockProvider } from './runtime/mock-provider.js'
import { MockSandbox } from './runtime/mock-sandbox.js'

export interface CliOptions {
  goal: string
  rounds: number
  population: number
  seed: number
  dbPath: string
  criteria: string | null
}

export interface CliOutput {
  rounds: { idx: number; meanScore: number; bestScore: number; metaDigest: string }[]
  winner: { label: string; strategyMd: string; score: number }
}

export async function runTournamentCli(opts: CliOptions): Promise<CliOutput> {
  const db = openDb(opts.dbPath)
  const repos = makeRepos(db)

  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    populationSize: opts.population,
    sandbox: 'mock',
    roster: [{ modelId: 'mock/model', count: opts.population, temperature: 0.7 }],
  }

  const provider = new MockProvider(opts.seed)
  const sandbox = new MockSandbox()
  const engine = new TournamentEngine({
    repos,
    config,
    sandbox,
    runner: new MockAgentRunner(sandbox, opts.seed),
    judge: new Judge(provider, config.judge, opts.seed),
    // Derived from the roster, never hardcoded: Reflector silently falls back to the
    // current model for any model_id outside this list, so a hardcoded array would
    // reject every legitimate model the moment Phase 2 supplies a real roster — and
    // would do so without raising anything.
    reflector: new Reflector(provider, config.reflect, config.roster.map((r) => r.modelId)),
    // Each agent starts from a different keyword so imitation has something real to
    // transfer. Uniform seeds leave nothing to imitate and the curve stays flat.
    seedStrategy: (i) =>
      `attempt the goal, variant ${i}, focus on ${GOOD_KEYWORDS[i % GOOD_KEYWORDS.length]}`,
  })

  const run = engine.createRun('cli', opts.goal)
  const rounds: CliOutput['rounds'] = []
  let finalRoundId: string | null = null
  let finalRoundIdx = 0

  for (let i = 0; i < opts.rounds; i++) {
    const r = await engine.runRound(run.id, { goalMd: opts.goal, criteriaMd: opts.criteria })
    const scores = repos.scores.forRound(r.roundId)
    const values = scores.map((s) => s.score)
    finalRoundId = r.roundId
    finalRoundIdx = r.roundIdx
    rounds.push({
      idx: r.roundIdx,
      meanScore: values.reduce((a, b) => a + b, 0) / values.length,
      bestScore: Math.max(...values),
      metaDigest: r.metaDigest,
    })
  }

  // The winner is the rank-1 agent of the final round. Scanning `listActive` for the
  // first agent that happens to have a genome returns whoever sorts first by label,
  // which is an arbitrary competitor rather than the one that won.
  const champion = finalRoundId ? repos.scores.forRound(finalRoundId)[0] : undefined
  const championAgent = champion
    ? repos.agents.listActive(run.id).find((a) => a.id === champion.agentId)
    : undefined
  const championGenome = champion
    ? repos.genomes.forRound(champion.agentId, finalRoundIdx)
    : null

  return {
    rounds,
    winner: {
      label: championAgent?.label ?? '',
      strategyMd: championGenome?.strategyMd ?? '',
      score: champion?.score ?? 0,
    },
  }
}

// `file://${process.argv[1]}` never matches on Windows: argv[1] is a backslash path
// and import.meta.url is a percent-encoded file URL, so the CLI would silently
// print nothing. pathToFileURL normalizes both sides.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      goal: { type: 'string', default: 'Produce the best possible answer.' },
      rounds: { type: 'string', default: '5' },
      population: { type: 'string', default: '20' },
      seed: { type: 'string', default: '42' },
      db: { type: 'string', default: ':memory:' },
    },
  })

  const out = await runTournamentCli({
    goal: values.goal!,
    rounds: Number(values.rounds),
    population: Number(values.population),
    seed: Number(values.seed),
    dbPath: values.db!,
    criteria: null,
  })

  console.log(`\nGoal: ${values.goal}\n`)
  for (const r of out.rounds) {
    console.log(`Round ${r.idx}: mean ${r.meanScore.toFixed(2)}  best ${r.bestScore.toFixed(2)}`)
  }
  console.log(`\nWinning strategy (${out.winner.label}):\n${out.winner.strategyMd}\n`)
}
