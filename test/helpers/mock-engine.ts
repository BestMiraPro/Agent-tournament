import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import { MockAgentRunner } from '../../src/runtime/agent-runner.js'

export function makeMockEngine(opts: {
  seed: number
  populationSize: number
  failFirst?: boolean
}) {
  const db = openDb(':memory:')
  const repos = makeRepos(db)

  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    populationSize: opts.populationSize,
    sandbox: 'mock',
    concurrency: 4,
    roster: [{ modelId: 'mock/model', count: opts.populationSize, temperature: 0.7 }],
  }

  const provider = new MockProvider(opts.seed)
  const sandbox = new MockSandbox()
  const engine = new TournamentEngine({
    repos,
    config,
    sandbox,
    runner: new MockAgentRunner(sandbox, opts.seed),
    judge: new Judge(provider, config.judge, opts.seed),
    reflector: new Reflector(provider, config.reflect, ['mock/model']),
    seedStrategy: (i) =>
      opts.failFirst && i === 0 ? '__FAIL__' : `attempt the goal, variant ${i}`,
  })

  return { db, repos, engine, config }
}
