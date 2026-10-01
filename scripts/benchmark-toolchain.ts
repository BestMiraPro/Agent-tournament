/**
 * Measures the research toolchain under candidate container sizes, so a smaller default is
 * chosen from evidence rather than from summed ceilings.
 *
 *   npx tsx scripts/benchmark-toolchain.ts [--sizes 512m,768m,1g] [--cpus 0.5,1] [--repeat 2] [--concurrent 1] [--out file.json]
 *
 * `--concurrent 7` starts seven identical containers at once per trial: the population sharing
 * this host's CPUs and memory, which one container alone does not show.
 *
 * Each trial starts one container with the protected worker's filesystem shape (read-only root,
 * uid 1000, 256m tmpfs home and /tmp, no network, pinned model catalogue) and the requested limits, runs `opencode serve`
 * in it as a real worker does, then a bounded research workload beside it: imports, a 2-million-row
 * dataframe backtest, a DuckDB aggregation, a matplotlib chart and a pytest run. The container
 * reports its own cgroup peak memory, OOM kills and CPU throttling. No model is called and nothing
 * is downloaded. Every container is named `arena-bench-*` and removed after its trial.
 */
import { parseArgs } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { docker } from '../src/runtime/docker/cli.js'
import { hostModelsCatalog } from '../src/runtime/opencode/discovery.js'
import { agentImageTag, readToolchainId } from '../src/runtime/tool-manifest.js'
import { TOOLS_MOUNT } from '../src/runtime/tool-manifest.js'
import { RelayPolicy } from '../src/runtime/provider-relay.js'
import { startProviderRelay, type UpstreamCall } from '../src/runtime/provider-relay-server.js'
import { DockerSandbox } from '../src/runtime/docker/sandbox.js'
import {
  inspectContainerState,
  inspectRuntimeState,
  startShardContainer,
} from '../src/runtime/docker/container.js'
import { createShardNetwork, removeShardNetwork } from '../src/runtime/docker/network.js'
import { CapacityLedger, readHostCapacity } from '../src/runtime/docker/capacity.js'
import { GATEWAY_CPUS, GATEWAY_MEMORY_BYTES } from '../src/runtime/docker/gateway-limits.js'
import { OpenCodeClient } from '../src/runtime/opencode/client.js'
import { relayProviderConfig } from '../src/runtime/opencode/relay-config.js'
import { splitModelId } from '../src/runtime/opencode/model-id.js'
import { COMPETITOR_AGENT } from '../src/runtime/opencode/agent-runner.js'
import { serializeCompetitorProfile } from '../src/core/genome.js'
import { parseMemoryLimit } from '../src/core/memory.js'
import {
  BENCH_MODEL,
  countSessionToolTurns,
  countToolTurns,
  scriptedSse,
} from '../src/benchmark/scripted-upstream.js'
import {
  evaluateCandidate,
  recommendDefault,
  recommendSimultaneous,
  type CandidateEvidence,
  type RepetitionEvidence,
  type WorkerRoundMeasurement,
} from '../src/benchmark/sizing.js'

const WORKLOAD = String.raw`
set -u
mkdir -p "$HOME/.cache/opencode" /tmp/bench && cp /run/arena-config/models.json "$HOME/.cache/opencode/models.json" && cd /tmp/bench
start=$(date +%s%N)
ok=0
opencode serve --hostname 127.0.0.1 --port 4096 >/tmp/bench/opencode.log 2>&1 &
for i in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:4096/global/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then ok=1; break; fi
  sleep 0.5
done
ready=$(date +%s%N)
idle=$(cat /sys/fs/cgroup/memory.current)
cat > test_backtest.py <<'EOF'
import numpy as np, pandas as pd, duckdb, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def run():
    rng = np.random.default_rng(7)
    n = 2_000_000
    df = pd.DataFrame({"asset": rng.integers(0, 50, n), "ret": rng.normal(0, 0.01, n)})
    df["signal"] = df.groupby("asset")["ret"].transform(lambda s: s.rolling(20, min_periods=1).mean())
    df["pnl"] = np.sign(df["signal"].shift(1).fillna(0)) * df["ret"]
    summary = duckdb.sql("select asset, sum(pnl) as pnl, stddev(ret) as vol from df group by asset order by pnl desc").df()
    fig, ax = plt.subplots()
    ax.plot(df["pnl"].iloc[:50_000].cumsum().to_numpy())
    fig.savefig("equity.png")
    return summary

def test_backtest():
    s = run()
    assert len(s) == 50
EOF
python -m pytest -q -p no:cacheprovider test_backtest.py >/tmp/bench/pytest.log 2>&1
status=$?
done=$(date +%s%N)
echo "RESULT ready_ok=$ok ready_ms=$(( (ready-start)/1000000 )) work_ms=$(( (done-ready)/1000000 )) pytest=$status idle_bytes=$idle peak_bytes=$(cat /sys/fs/cgroup/memory.peak) oom_kill=$(grep '^oom_kill ' /sys/fs/cgroup/memory.events | cut -d' ' -f2) throttled_usec=$(grep '^throttled_usec ' /sys/fs/cgroup/cpu.stat | cut -d' ' -f2) swap_peak=$(cat /sys/fs/cgroup/memory.swap.peak 2>/dev/null || echo na)"
`

interface Trial {
  memory: string
  cpus: number
  repeat: number
  concurrent: number
  exitCode: number
  readyMs: number | null
  workMs: number | null
  pytestPassed: boolean
  idleMiB: number | null
  peakMiB: number | null
  oomKills: number | null
  throttledSeconds: number | null
  note: string | null
}

const { values } = parseArgs({
  options: {
    sizes: { type: 'string', default: '512m,768m,1g' },
    cpus: { type: 'string', default: '0.5,1' },
    repeat: { type: 'string', default: '2' },
    concurrent: { type: 'string', default: '1' },
    out: { type: 'string' },
    // Sustained-conversation mode (Task C): real OpenCode processes through the production
    // protected worker/gateway launch path, driven by a scripted deterministic upstream.
    // `--mode sustained` runs it; the research trials above stay the default.
    mode: { type: 'string', default: 'research' },
    lifecycle: { type: 'string', default: 'both' },
    rounds: { type: 'string', default: '10' },
    turns: { type: 'string', default: '100' },
    agents: { type: 'string', default: '1' },
    'max-agents': { type: 'string', default: '8' },
    'prompt-timeout-ms': { type: 'string', default: '1800000' },
    tag: { type: 'string', default: '' },
    recovery: { type: 'boolean', default: false },
  },
})

const mib = (bytes: string | undefined) => (bytes && /^\d+$/.test(bytes) ? Math.round(Number(bytes) / 1024 / 1024) : null)

async function trial(image: string, catalogue: string, memory: string, cpus: number, repeat: number, concurrent: number): Promise<Trial> {
  const name = `arena-bench-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const r = await docker([
    'run', '--rm', '--name', name, '--network', 'none',
    '-m', memory, '--memory-swap', memory, '--cpus', String(cpus), '--pids-limit', '256',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--user', '1000:1000', '-e', 'HOME=/home/arena',
    '--tmpfs', '/home/arena:rw,uid=1000,gid=1000,size=256m', '--tmpfs', '/tmp:rw,uid=1000,gid=1000,size=256m',
    // As a protected worker: catalogue pinned and copied into HOME, no catalogue fetch. Without
    // these OpenCode blocks offline fetching the catalogue and never answers health.
    '-v', `${catalogue}:/run/arena-config/models.json:ro`, '-e', 'OPENCODE_DISABLE_MODELS_FETCH=1',
    '-e', `OMP_NUM_THREADS=${Math.max(1, Math.floor(cpus))}`, '-e', `OPENBLAS_NUM_THREADS=${Math.max(1, Math.floor(cpus))}`,
    '--entrypoint', 'sh', image, '-c', WORKLOAD,
  ], 900_000)
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT ')) ?? ''
  const field = (k: string) => new RegExp(`${k}=(\\S+)`).exec(line)?.[1]
  const num = (k: string) => (field(k) && /^\d+$/.test(field(k)!) ? Number(field(k)) : null)
  return {
    memory, cpus, repeat, concurrent, exitCode: r.code,
    readyMs: field('ready_ok') === '1' ? num('ready_ms') : null, workMs: num('work_ms'), pytestPassed: field('pytest') === '0',
    idleMiB: mib(field('idle_bytes')), peakMiB: mib(field('peak_bytes')),
    oomKills: num('oom_kill'), throttledSeconds: num('throttled_usec') === null ? null : Math.round(num('throttled_usec')! / 1e5) / 10,
    // A container killed outright prints no RESULT line; the exit code (137) is then the evidence.
    note: line ? null : `no result line (exit ${r.code})${r.code === 137 ? ': killed, most likely out of memory' : ''}`,
  }
}

if (values.mode === 'research') {
const toolchainId = await readToolchainId(process.cwd())
const image = agentImageTag(toolchainId)
const catalogue = hostModelsCatalog(process.env, homedir(), existsSync)
if (!catalogue) throw new Error('No host model catalogue (~/.cache/opencode/models.json): run OpenCode once first.')
const sizes = values.sizes!.split(',').map((s) => s.trim())
const cpuList = values.cpus!.split(',').map(Number)
const repeats = Math.max(1, Number(values.repeat))
const concurrent = Math.max(1, Number(values.concurrent))
const info = await docker(['info', '--format', '{{.MemTotal}}|{{.NCPU}}|{{.ServerVersion}}'])
const [memTotal, ncpu, version] = info.stdout.trim().split('|')

const trials: Trial[] = []
for (const memory of sizes) {
  for (const cpus of cpuList) {
    for (let i = 1; i <= repeats; i++) {
      const batch = await Promise.all(Array.from({ length: concurrent }, () => trial(image, catalogue, memory, cpus, i, concurrent)))
      for (const t of batch) {
        trials.push(t)
        console.log(JSON.stringify(t))
      }
    }
  }
}

const report = {
  measuredAt: new Date().toISOString(),
  image,
  docker: { version, memTotalMiB: mib(memTotal), cpus: Number(ncpu) },
  trials,
}
if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('\n| Memory | CPUs | Concurrent | OpenCode ready (s) | Workload (s) | Idle MiB | Peak MiB | OOM | Throttled (s) | pytest |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
for (const t of trials) {
  const s = (ms: number | null) => (ms === null ? '—' : (ms / 1000).toFixed(1))
  console.log(`| ${t.memory} | ${t.cpus} | ${t.concurrent} | ${s(t.readyMs)} | ${s(t.workMs)} | ${t.idleMiB ?? '—'} | ${t.peakMiB ?? '—'} | ${t.oomKills ?? '—'} | ${t.throttledSeconds ?? '—'} | ${t.pytestPassed ? 'pass' : t.note ?? 'fail'} |`)
}
} // values.mode === 'research'

// ---------------------------------------------------------------------------
// Sustained-conversation benchmark (Task C).
//
// Compares the retained-worker lifecycle against the recycled-worker lifecycle
// (DockerSandbox.releaseRound between rounds) under a real OpenCode conversation:
// production protected worker/gateway launch arguments, the production provider
// relay, a scripted deterministic OpenAI-compatible upstream (synthetic token, no
// credentials, no paid providers), the pandas/DuckDB/matplotlib research workload
// inside a 100-tool-turn conversation, submission capture before teardown, a
// population change mid-run, and a separate worker-death recovery scenario.
//
// Safety: containers are named `arena-<runId>-<shard>` under a benchmark-only run
// id and are removed by exact name only. This script NEVER sweeps, NEVER removes
// by pattern, and NEVER touches `Agent containers/`, `Agents work v2/`, `runs/`,
// or any container it did not create. A live tournament shares this Docker host;
// the sweep below stops at admission refusal, and every stage re-verifies the
// live containers are still present.
// ---------------------------------------------------------------------------

const BENCH_GOAL = 'Sustained research: run the backtest, synthesize follow-up analyses with python, and keep using tools until told to finish.'
const BENCH_STRATEGY = 'You are a benchmark researcher. Work steadily with the bash tool in your workspace. Never stop early: there is always another analysis to run.'
const BENCH_BACKTEST_PY = `import numpy as np, pandas as pd, duckdb, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def run():
    rng = np.random.default_rng(7)
    n = 2_000_000
    df = pd.DataFrame({"asset": rng.integers(0, 50, n), "ret": rng.normal(0, 0.01, n)})
    df["signal"] = df.groupby("asset")["ret"].transform(lambda s: s.rolling(20, min_periods=1).mean())
    df["pnl"] = np.sign(df["signal"].shift(1).fillna(0)) * df["ret"]
    summary = duckdb.sql("select asset, sum(pnl) as pnl, stddev(ret) as vol from df group by asset order by pnl desc").df()
    fig, ax = plt.subplots()
    ax.plot(df["pnl"].iloc[:50_000].cumsum().to_numpy())
    fig.savefig("equity.png")
    return summary

def test_backtest():
    s = run()
    assert len(s) == 50
`

interface SustainedHostSnapshot {
  at: string
  totalMemoryBytes: number
  usedMemoryBytes: number
  unrelatedBytes: number
  benchBytes: number
  cpus: number
  orchestrationRssBytes: number
}

interface SustainedRoundEvidence {
  round: number
  agents: string[]
  gatewayMiB: (number | null)[]
  host: SustainedHostSnapshot
}

const numOr = (v: string | undefined, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** This benchmark run's containers (read-only listing; removal is always by exact name). */
async function benchContainers(runId: string): Promise<string[]> {
  const r = await docker(['ps', '-a', '--filter', `name=^arena-${runId}-`, '--format', '{{.Names}}'], 20_000)
  if (r.code !== 0) return []
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** Every arena container that is NOT this benchmark run's, so stages confirm they survived. */
async function liveArenaContainers(runId: string): Promise<string[]> {
  const r = await docker(['ps', '-a', '--filter', 'name=^arena-', '--format', '{{.Names}}'], 20_000)
  if (r.code !== 0) return []
  const prefix = `arena-${runId}-`
  return r.stdout.split('\n').map((s) => s.trim()).filter((n) => n && !n.startsWith(prefix))
}

async function snapshotHost(runId: string): Promise<SustainedHostSnapshot> {
  const host = await readHostCapacity()
  let benchBytes = 0
  for (const c of host.containers ?? []) {
    if (c.name.startsWith(`arena-${runId}-`)) benchBytes += c.usedBytes
  }
  return {
    at: new Date().toISOString(),
    totalMemoryBytes: host.totalMemoryBytes,
    usedMemoryBytes: host.usedMemoryBytes,
    unrelatedBytes: Math.max(0, host.usedMemoryBytes - benchBytes),
    benchBytes,
    cpus: host.cpus,
    orchestrationRssBytes: process.memoryUsage().rss,
  }
}

interface CgroupRead {
  current: number | null
  peak: number | null
  anon: number | null
  file: number | null
  shmem: number | null
  oomKill: number | null
}

/** Current and peak cgroup memory plus OOM counters, read from the host by exact name. */
async function readCgroup(name: string): Promise<CgroupRead> {
  const empty: CgroupRead = { current: null, peak: null, anon: null, file: null, shmem: null, oomKill: null }
  const r = await docker(['exec', name, 'sh', '-c',
    'echo "current=$(cat /sys/fs/cgroup/memory.current 2>/dev/null)";' +
    'echo "peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null)";' +
    'echo "anon=$(grep -E ^anon\\  /sys/fs/cgroup/memory.stat 2>/dev/null | cut -d\\  -f2)";' +
    'echo "file=$(grep -E ^file\\  /sys/fs/cgroup/memory.stat 2>/dev/null | cut -d\\  -f2)";' +
    'echo "shmem=$(grep -E ^shmem\\  /sys/fs/cgroup/memory.stat 2>/dev/null | cut -d\\  -f2)";' +
    'echo "oom=$(grep -E ^oom_kill\\  /sys/fs/cgroup/memory.events 2>/dev/null | cut -d\\  -f2)"',
  ], 30_000)
  if (r.code !== 0) return empty
  const field = (k: string): number | null => {
    const m = new RegExp(`^${k}=(\\d+)$`, 'm').exec(r.stdout)
    return m ? Number(m[1]) : null
  }
  return { current: field('current'), peak: field('peak'), anon: field('anon'), file: field('file'), shmem: field('shmem'), oomKill: field('oom') }
}

async function gatewayCurrentMiB(gatewayName: string): Promise<number | null> {
  const cg = await readCgroup(gatewayName)
  return cg.current === null ? null : Math.round(cg.current / 1024 ** 2)
}

interface SustainedCtx {
  image: string
  catalogJson: string
  cpus: number
  rounds: number
  turns: number
  callsPerStep: number
  promptTimeoutMs: number
  tag: string
  seq: { current: number }
}

async function prepareAgentFiles(sandbox: DockerSandbox, handle: { agentId: string }, label: string): Promise<void> {
  await sandbox.reset(handle as never, {})
  await sandbox.writeFile(handle as never, 'NOTES.md', `${label} notes.\n`)
  await sandbox.writeFile(handle as never, 'GOAL.md', `${BENCH_GOAL}\n`)
  await sandbox.writeFile(handle as never, 'test_backtest.py', BENCH_BACKTEST_PY)
  await sandbox.writeFile(handle as never, '.opencode/agents/competitor.md', serializeCompetitorProfile(
    { strategyMd: BENCH_STRATEGY, notesMd: '', modelId: BENCH_MODEL, temperature: 0.7 },
    { label, readableDirs: [TOOLS_MOUNT] },
  ))
}

async function sessionToolTurns(baseUrl: string, sessionId: string, directory: string): Promise<number> {
  const res = await fetch(`${baseUrl}/session/${sessionId}/message?directory=${encodeURIComponent(directory)}`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`message listing failed: ${res.status}`)
  return countSessionToolTurns(await res.json())
}

async function runAgentRound(
  ctx: SustainedCtx,
  sandbox: DockerSandbox,
  handle: { agentId: string; workspacePath: string; baseUrl?: string },
  round: number,
  onSession: (agentId: string, sessionId: string) => void,
): Promise<{ turns: number; submissionPresent: boolean; promptAttempts: number }> {
  const client = new OpenCodeClient({ baseUrl: (handle as { baseUrl: string }).baseUrl, timeoutMs: ctx.promptTimeoutMs })
  const session = await client.createSession(handle.workspacePath, `bench-r${round}-${handle.agentId}`)
  onSession(handle.agentId, session.id)
  const body = {
    model: splitModelId(BENCH_MODEL),
    agent: COMPETITOR_AGENT,
    system: BENCH_STRATEGY,
    parts: [{ type: 'text' as const, text: `Round ${round}: ${BENCH_GOAL} Write SUBMISSION.md when finished.` }],
  }
  let turns = 0
  let promptAttempts = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    promptAttempts++
    const text = attempt === 0 ? body : { ...body, parts: [{ type: 'text' as const, text: `Continue: run more tool analyses (currently ${turns} exchanges, need ${ctx.turns}).` }] }
    await client.prompt(session.id, handle.workspacePath, text, ctx.promptTimeoutMs)
    turns = await sessionToolTurns((handle as { baseUrl: string }).baseUrl, session.id, handle.workspacePath)
    if (turns >= ctx.turns) break
  }
  const submission = await sandbox.readFile(handle as never, 'SUBMISSION.md')
  return { turns, submissionPresent: submission !== null && submission.length > 0, promptAttempts }
}

interface RepetitionResult {
  evidence: RepetitionEvidence
  rounds: SustainedRoundEvidence[]
  liveBefore: string[]
  liveAfter: string[]
}

/** One full multi-round repetition for a candidate. Owns every container it creates. */
async function runRepetition(
  ctx: SustainedCtx,
  lifecycle: 'retained' | 'recycled',
  memory: string,
  simultaneous: number,
  stream?: (line: Record<string, unknown>) => Promise<void>,
): Promise<RepetitionResult> {
  const runId = `bench${ctx.tag}${ctx.seq.current++}`
  if (!/^[A-Za-z0-9]+$/.test(runId)) throw new Error(`unsafe benchmark run id: ${runId}`)
  const token = `bench-token-${runId}`
  const warnings: string[] = []
  const onWarning = (m: string): void => { warnings.push(m) }
  const liveBefore = await liveArenaContainers(runId)

  const policy = new RelayPolicy([], { maxRequestBytes: 16 * 1024 * 1024, maxResponseBytes: 16 * 1024 * 1024 })
  const upstream: UpstreamCall = async (_url, init) => {
    const payload = scriptedSse({ agentId: 'bench', toolTurns: countToolTurns(init.body), turnBudget: ctx.turns, callsPerStep: ctx.callsPerStep })
    async function* body(): AsyncGenerator<Uint8Array> { yield Buffer.from(payload) }
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: body() }
  }
  policy.grant(runId, {
    token, allowedModels: [BENCH_MODEL], maxRequests: 100_000,
    upstreams: [{ providerId: 'wandb', baseUrl: 'https://upstream.invalid/v1', authStyle: 'bearer', apiKey: 'SYNTHETIC-UPSTREAM-KEY' }],
  })
  const relay = await startProviderRelay({ policy, upstream })

  const root = await mkdtemp(join(tmpdir(), `arena-bench-${runId}-`))
  const networks = new Set<string>()
  const gateways = new Map<string, string>()
  const toolsReady = new Set<number>()
  const endpoints = new Set<string>()
  const sessionsHeld = new Map<string, string>()
  const bookkeeping: RepetitionEvidence['bookkeeping'] = []
  const workers: WorkerRoundMeasurement[] = []
  const roundNotes: SustainedRoundEvidence[] = []
  const sandbox = new DockerSandbox({
    runId, root, maxContainers: simultaneous, image: ctx.image, memory, cpus: ctx.cpus,
    authFile: null, isolation: 'protected',
    startContainer: async (shardIndex, hostDir) => {
      const toolsDir = join(root, `tools-${shardIndex}`)
      if (!toolsReady.has(shardIndex)) {
        await mkdir(toolsDir, { recursive: true })
        await writeFile(join(toolsDir, 'TOOLS.md'), '# benchmark fixture\n', 'utf8')
        await writeFile(join(toolsDir, 'tools.json'), '{}\n', 'utf8')
        toolsReady.add(shardIndex)
      }
      const configDir = join(root, `config-${shardIndex}`)
      await mkdir(configDir, { recursive: true })
      await writeFile(join(configDir, 'opencode.json'), relayProviderConfig({ providers: ['wandb'], relayBaseUrl: 'http://gateway:8787', token }), 'utf8')
      await writeFile(join(configDir, 'models.json'), ctx.catalogJson, 'utf8')
      let network: string | undefined
      for (const n of networks) if (n === `arena-${runId}-net-${shardIndex}`) network = n
      if (!network) {
        network = await createShardNetwork(runId, shardIndex)
        networks.add(network)
      }
      const started = await startShardContainer(
        {
          runId, shardIndex, image: ctx.image, hostDir, toolsDir, memory, cpus: ctx.cpus,
          authFile: null, protectedRuntime: { network, configDir, relayPort: relay.port },
        },
        undefined,
        async (baseUrl) => fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
        onWarning,
      )
      if (started.gatewayName) gateways.set(started.name, started.gatewayName)
      endpoints.add(started.baseUrl)
      return started
    },
    stopContainer: async (name) => {
      await docker(['rm', '-f', name], 30_000)
      const gateway = gateways.get(name)
      if (gateway) {
        await docker(['rm', '-f', gateway], 30_000)
        gateways.delete(name)
      }
    },
    runtimeStateOf: (id) => inspectRuntimeState(id),
    onWarning,
  })

  try {
    for (let round = 1; round <= ctx.rounds; round++) {
      const roundT0 = Date.now()
      // Population change mid-run: same count, changed membership from round 6 on.
      const agents = Array.from({ length: simultaneous }, (_, i) =>
        round <= 5 ? `bench${ctx.seq.current}a${i}` : (i === simultaneous - 1 ? `bench${ctx.seq.current}b0` : `bench${ctx.seq.current}a${i}`))
      await sandbox.planFor(agents)
      const readyMs = new Map<string, number>()
      const handles = new Map<string, { agentId: string; workspacePath: string; baseUrl: string; runtimeId?: string }>()
      for (const [i, agentId] of agents.entries()) {
        const t0 = Date.now()
        const h = await sandbox.provision(agentId, {}) as unknown as { agentId: string; workspacePath: string; baseUrl: string; runtimeId?: string }
        readyMs.set(agentId, Date.now() - t0)
        await prepareAgentFiles(sandbox, h, `bench-agent-${i}`)
        handles.set(agentId, h)
      }
      const sessionsThisRound = new Map<string, string>()
      const results = new Map<string, { turns: number; submissionPresent: boolean; promptAttempts: number }>()
      await Promise.all(agents.map(async (agentId) => {
        try {
          results.set(agentId, await runAgentRound(ctx, sandbox, handles.get(agentId)!, round, (a, s) => { sessionsThisRound.set(a, s) }))
        } catch (e) {
          warnings.push(`agent ${agentId} round ${round} failed: ${(e as Error).message.slice(0, 300)}`)
          results.set(agentId, { turns: 0, submissionPresent: false, promptAttempts: 0 })
        }
      }))
      // Capture-before-teardown ordering, as production does: read every
      // submission while the workers are still live, then retire the mappings.
      for (const [agentId, sessionId] of sessionsThisRound) sessionsHeld.set(agentId, sessionId)
      const gatewayMiB: (number | null)[] = []
      for (const agentId of agents) {
        const h = handles.get(agentId)!
        const workerName = sandbox.containerNameFor(agentId)
        const cg = workerName ? await readCgroup(workerName) : { current: null, peak: null, anon: null, file: null, shmem: null, oomKill: null }
        const end = workerName ? await inspectContainerState(workerName) : null
        let exitCode: number | null = null
        const workerRunning = end?.running ?? true
        if (workerName && !workerRunning) {
          const insp = await docker(['inspect', '-f', '{{.State.ExitCode}}', workerName], 20_000)
          exitCode = insp.code === 0 && /^\d+$/.test(insp.stdout.trim()) ? Number(insp.stdout.trim()) : null
        }
        const gw = workerName ? gateways.get(workerName) ?? null : null
        gatewayMiB.push(gw ? await gatewayCurrentMiB(gw) : null)
        const r = results.get(agentId)!
        workers.push({
          worker: workerName ?? `${agentId}-missing`,
          containerId: h.runtimeId ?? null,
          memoryLimitBytes: parseMemoryLimit(memory),
          peakBytes: cg.peak, currentBytes: cg.current, anonBytes: cg.anon, tmpfsBytes: cg.shmem,
          oomKills: cg.oomKill, oomKilled: end?.oomKilled ?? null, exitCode,
          running: workerRunning, readyMs: readyMs.get(agentId) ?? null,
          completed: r.turns >= ctx.turns && r.submissionPresent,
          submissionsExpected: 1, submissionsPresent: r.submissionPresent ? 1 : 0,
          cleanupMs: null, leftovers: [], toolTurns: r.turns,
        })
      }
      // Retire this round's mappings now that its evidence is frozen: a repeat
      // round must not accumulate endpoint/session bookkeeping.
      sessionsHeld.clear()
      // Host accounting while the round's workers are still live, before cleanup.
      const hostSnapshot = await snapshotHost(runId)
      const lastRound = round === ctx.rounds
      const needsCleanup = lifecycle === 'recycled' || lastRound
      let cleanupMs: number | null = null
      let leftovers: string[] = []
      if (needsCleanup) {
        const t0 = Date.now()
        try {
          if (lifecycle === 'recycled') await sandbox.releaseRound()
          else await sandbox.disposeAll()
        } catch (e) {
          warnings.push(`cleanup round ${round} failed: ${(e as Error).message.slice(0, 300)}`)
        }
        cleanupMs = Date.now() - t0
        for (const name of await benchContainers(runId)) leftovers.push(name)
        for (const [agentId, h] of handles) {
          const id = (h as { runtimeId?: string }).runtimeId
          if (id && await inspectRuntimeState(id) === 'running') leftovers.push(`${agentId}-still-running`)
        }
        if (lifecycle === 'recycled') endpoints.clear()
        for (let i = workers.length - agents.length; i < workers.length; i++) {
          workers[i]!.cleanupMs = cleanupMs
          workers[i]!.leftovers = [...leftovers]
        }
      }
      bookkeeping.push({ round, endpoints: endpoints.size, sessions: sessionsHeld.size })
      roundNotes.push({ round, agents: [...agents], gatewayMiB, host: hostSnapshot })
      const roundLine = { type: 'round', runId, lifecycle, memory, simultaneous, round, elapsedMs: Date.now() - roundT0, turns: agents.map((a) => results.get(a)!.turns), attempts: agents.map((a) => results.get(a)!.promptAttempts), submissions: agents.map((a) => results.get(a)!.submissionPresent), cleanupMs, leftovers, warnings: warnings.slice(-2) }
      console.log(JSON.stringify({ lifecycle, memory, simultaneous, round, elapsedMs: roundLine.elapsedMs, turns: roundLine.turns, attempts: roundLine.attempts, submissions: roundLine.submissions, cleanupMs, leftovers, warnings: roundLine.warnings }))
      await stream?.(roundLine)
    }
  } finally {
    try { await sandbox.disposeAll() } catch { /* best effort */ }
    for (const name of await benchContainers(runId)) await docker(['rm', '-f', name], 30_000)
    for (const n of networks) await removeShardNetwork(n, onWarning)
    await relay.close()
    await rm(root, { recursive: true, force: true })
  }
  const remaining = await benchContainers(runId)
  for (const name of remaining) warnings.push(`leaked container ${name}`)
  const liveAfter = await liveArenaContainers(runId)
  const liveLost = liveBefore.filter((n) => !liveAfter.includes(n))
  if (liveLost.length > 0) warnings.push(`LIVE CONTAINERS MISSING AFTER REPETITION (may be their own round transition — verify): ${liveLost.join(', ')}`)
  return {
    evidence: { completedRounds: ctx.rounds, workers, bookkeeping },
    rounds: roundNotes,
    liveBefore,
    liveAfter,
  }
}

interface CandidateResult {
  evidence: CandidateEvidence
  eligible: boolean
  failures: string[]
  admitted: boolean
  admissionNote: string | null
  hostBefore: SustainedHostSnapshot
  repetitions: RepetitionResult[]
}

/** Admission through the server's own ledger arithmetic, worker plus gateway ceilings. */
async function runCandidate(
  ctx: SustainedCtx,
  ledger: CapacityLedger,
  lifecycle: 'retained' | 'recycled',
  memory: string,
  simultaneous: number,
  maxReps: number,
  stream?: (line: Record<string, unknown>) => Promise<void>,
): Promise<CandidateResult> {
  const hostBefore = await snapshotHost('bench')
  const host = await readHostCapacity()
  const perContainer = parseMemoryLimit(memory) + GATEWAY_MEMORY_BYTES
  const verdict = ledger.admit(`bench-${ctx.tag}-${lifecycle}-${memory}-${simultaneous}`, {
    containers: simultaneous,
    memoryBytes: perContainer,
    cpus: ctx.cpus + GATEWAY_CPUS,
  }, host)
  if (!verdict.ok) {
    const failed: CandidateResult = {
      evidence: {
        lifecycle, memory, simultaneous, minToolTurns: ctx.turns, rounds: ctx.rounds,
        admittedWithoutHostChanges: true, repetitions: [],
      },
      eligible: false, failures: [`admission refused: ${verdict.reason}`],
      admitted: false, admissionNote: verdict.reason, hostBefore, repetitions: [],
    }
    await stream?.({ type: 'candidate', lifecycle, memory, simultaneous, admitted: false, eligible: false, failures: failed.failures })
    return failed
  }
  try {
    const repetitions: RepetitionResult[] = []
    // One run first; only a passing candidate is repeated to three.
    repetitions.push(await runRepetition(ctx, lifecycle, memory, simultaneous, stream))
    let evidence: CandidateEvidence = {
      lifecycle, memory, simultaneous, minToolTurns: ctx.turns, rounds: ctx.rounds,
      admittedWithoutHostChanges: true, repetitions: repetitions.map((r) => r.evidence),
    }
    let v = evaluateCandidate(evidence)
    if (v.eligible) {
      for (let i = 1; i < maxReps; i++) repetitions.push(await runRepetition(ctx, lifecycle, memory, simultaneous, stream))
      evidence = { ...evidence, repetitions: repetitions.map((r) => r.evidence) }
      v = evaluateCandidate(evidence)
    }
    await stream?.({ type: 'candidate', lifecycle, memory, simultaneous, admitted: true, eligible: v.eligible, failures: v.failures, reps: repetitions.length })
    return { evidence, eligible: v.eligible, failures: v.failures, admitted: true, admissionNote: null, hostBefore, repetitions }
  } finally {
    ledger.release(`bench-${ctx.tag}-${lifecycle}-${memory}-${simultaneous}`)
  }
}

/** Controlled worker death in a separate recovery scenario: SIGKILL mid-tournament. */
async function runRecovery(ctx: SustainedCtx, memory: string): Promise<Record<string, unknown>> {
  const runId = `bench${ctx.tag}rec${ctx.seq.current++}`
  const token = `bench-token-${runId}`
  const notes: Record<string, unknown> = { runId, memory }
  const policy = new RelayPolicy([], { maxRequestBytes: 16 * 1024 * 1024, maxResponseBytes: 16 * 1024 * 1024 })
  const upstream: UpstreamCall = async (_url, init) => {
    const payload = scriptedSse({ agentId: 'bench', toolTurns: countToolTurns(init.body), turnBudget: 12, callsPerStep: ctx.callsPerStep })
    async function* body(): AsyncGenerator<Uint8Array> { yield Buffer.from(payload) }
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: body() }
  }
  policy.grant(runId, {
    token, allowedModels: [BENCH_MODEL], maxRequests: 100_000,
    upstreams: [{ providerId: 'wandb', baseUrl: 'https://upstream.invalid/v1', authStyle: 'bearer', apiKey: 'SYNTHETIC-UPSTREAM-KEY' }],
  })
  const relay = await startProviderRelay({ policy, upstream })
  const root = await mkdtemp(join(tmpdir(), `arena-bench-${runId}-`))
  const gateways = new Map<string, string>()
  const warnings: string[] = []
  const sandbox = new DockerSandbox({
    runId, root, maxContainers: 1, image: ctx.image, memory, cpus: ctx.cpus,
    authFile: null, isolation: 'protected',
    startContainer: async (shardIndex, hostDir) => {
      const toolsDir = join(root, `tools-${shardIndex}`)
      await mkdir(toolsDir, { recursive: true })
      await writeFile(join(toolsDir, 'TOOLS.md'), '# benchmark fixture\n', 'utf8')
      await writeFile(join(toolsDir, 'tools.json'), '{}\n', 'utf8')
      const configDir = join(root, `config-${shardIndex}`)
      await mkdir(configDir, { recursive: true })
      await writeFile(join(configDir, 'opencode.json'), relayProviderConfig({ providers: ['wandb'], relayBaseUrl: 'http://gateway:8787', token }), 'utf8')
      await writeFile(join(configDir, 'models.json'), ctx.catalogJson, 'utf8')
      const network = await createShardNetwork(runId, shardIndex)
      const started = await startShardContainer(
        {
          runId, shardIndex, image: ctx.image, hostDir, toolsDir, memory, cpus: ctx.cpus,
          authFile: null, protectedRuntime: { network, configDir, relayPort: relay.port },
        },
        undefined,
        async (baseUrl) => fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
        (m) => warnings.push(m),
      )
      if (started.gatewayName) gateways.set(started.name, started.gatewayName)
      return { ...started, network }
    },
    stopContainer: async (name) => {
      await docker(['rm', '-f', name], 30_000)
      const gateway = gateways.get(name)
      if (gateway) {
        await docker(['rm', '-f', gateway], 30_000)
        gateways.delete(name)
      }
    },
    runtimeStateOf: (id) => inspectRuntimeState(id),
    onWarning: (m) => warnings.push(m),
  })
  try {
    await sandbox.planFor(['benchrec0'])
    const handle = await sandbox.provision('benchrec0', {}) as unknown as { agentId: string; workspacePath: string; baseUrl: string; runtimeId?: string }
    await prepareAgentFiles(sandbox, handle, 'recovery-agent')
    const workerName = sandbox.containerNameFor('benchrec0')!
    const firstId = handle.runtimeId ?? null
    notes.firstContainerId = firstId?.slice(0, 12) ?? null
    // Round 1 completes a short workload normally.
    const r1 = await runAgentRound({ ...ctx, turns: 12 }, sandbox, handle, 1, () => {})
    notes.round1 = r1
    // Controlled death: SIGKILL the worker mid-tournament (exit 137, not an OOM).
    const killed = await docker(['kill', workerName], 30_000)
    notes.killCode = killed.code
    await new Promise((r) => setTimeout(r, 3000))
    notes.runtimeState = await inspectRuntimeState(firstId ?? '')
    notes.inspect = await inspectContainerState(workerName)
    const exitInspect = await docker(['inspect', '-f', '{{.State.ExitCode}}', workerName], 20_000)
    notes.exitCode = exitInspect.code === 0 ? exitInspect.stdout.trim() : null
    // A prompt at the dead worker must fail loudly, never silently succeed.
    let deadPrompt: string
    try {
      const client = new OpenCodeClient({ baseUrl: handle.baseUrl, timeoutMs: 30_000 })
      const s = await client.createSession(handle.workspacePath, 'dead-check')
      await client.prompt(s.id, handle.workspacePath, {
        model: splitModelId(BENCH_MODEL), agent: COMPETITOR_AGENT, system: BENCH_STRATEGY,
        parts: [{ type: 'text' as const, text: 'Are you there?' }],
      }, 30_000)
      deadPrompt = 'UNEXPECTEDLY SUCCEEDED'
    } catch (e) {
      deadPrompt = `${(e as Error).name}: ${(e as Error).message.slice(0, 200)}`
    }
    notes.deadPrompt = deadPrompt
    // Recycle and run the next round on a fresh worker: the tournament continues.
    const t0 = Date.now()
    await sandbox.releaseRound()
    notes.releaseMs = Date.now() - t0
    await sandbox.planFor(['benchrec0'])
    const handle2 = await sandbox.provision('benchrec0', {}) as unknown as { agentId: string; workspacePath: string; baseUrl: string; runtimeId?: string }
    await prepareAgentFiles(sandbox, handle2, 'recovery-agent')
    notes.secondContainerId = handle2.runtimeId?.slice(0, 12) ?? null
    notes.freshInstance = firstId !== null && handle2.runtimeId !== null && firstId !== handle2.runtimeId
    const r2 = await runAgentRound({ ...ctx, turns: 12 }, sandbox, handle2, 2, () => {})
    notes.round2 = r2
    notes.recovered = r2.turns >= 12 && r2.submissionPresent
  } finally {
    try { await sandbox.disposeAll() } catch { /* best effort */ }
    for (const name of await benchContainers(runId)) await docker(['rm', '-f', name], 30_000)
    await removeShardNetwork(`arena-${runId}-net-0`, (m) => warnings.push(m))
    await relay.close()
    await rm(root, { recursive: true, force: true })
  }
  notes.leftoverContainers = await benchContainers(runId)
  notes.warnings = warnings
  return notes
}

async function runSustainedBenchmark(): Promise<void> {
  const lifecycles = values.lifecycle === 'both' ? ['retained', 'recycled'] as const : [values.lifecycle as 'retained' | 'recycled']
  const sizes = values.sizes!.split(',').map((s) => s.trim()).filter((s) => s === '1g' || s === '768m')
  if (sizes.length === 0) throw new Error(`sustained mode tests 1g and 768m; got "${values.sizes}" (512m is excluded: the research workload already OOMs there)`)
  const cpus = numOr(values.cpus!.split(',')[0], 1)
  const ctx: SustainedCtx = {
    image: agentImageTag(await readToolchainId(process.cwd())),
    catalogJson: await readFile(hostModelsCatalog(process.env, homedir(), existsSync)!, 'utf8'),
    cpus,
    rounds: numOr(values.rounds, 10),
    turns: numOr(values.turns, 100),
    callsPerStep: 4,
    promptTimeoutMs: numOr(values['prompt-timeout-ms'], 1800000),
    tag: (values.tag || Date.now().toString(36)).replace(/[^A-Za-z0-9]/g, ''),
    seq: { current: 0 },
  }
  if (!ctx.tag) ctx.tag = Date.now().toString(36)
  const ledger = new CapacityLedger()
  const startN = Math.max(1, Math.floor(numOr(values.agents, 1)))
  const maxN = Math.max(startN, Math.floor(numOr(values['max-agents'], 8)))
  const maxReps = Math.max(1, Math.floor(numOr(values.repeat, 3)))
  const info = await docker(['info', '--format', '{{.MemTotal}}|{{.NCPU}}|{{.ServerVersion}}'])
  const [memTotal, ncpu, version] = info.stdout.trim().split('|')

  const candidates: CandidateResult[] = []
  // JSONL stream beside --out: every round and candidate lands on disk as it
  // completes, so an interrupted run keeps its partials.
  const { appendFile } = await import('node:fs/promises')
  const jsonl = values.out ? `${values.out}.jsonl` : null
  const stream = jsonl
    ? async (line: Record<string, unknown>): Promise<void> => {
        await appendFile(jsonl, `${JSON.stringify(line)}\n`, 'utf8').catch((e) => console.log(JSON.stringify({ streamError: String(e).slice(0, 200) })))
      }
    : undefined
  for (const lifecycle of lifecycles) {
    for (const memory of sizes) {
      // Rising simultaneous counts within the admission budget; stop at refusal or failure.
      for (let n = startN; n <= maxN; n++) {
        const candidate = await runCandidate(ctx, ledger, lifecycle, memory, n, maxReps, stream)
        candidates.push(candidate)
        console.log(JSON.stringify({
          candidate: { lifecycle, memory, simultaneous: n },
          admitted: candidate.admitted, eligible: candidate.eligible, failures: candidate.failures,
        }))
        if (!candidate.admitted || !candidate.eligible) break
        
      }
    }
  }
  const recovery = values.recovery ? await runRecovery(ctx, '1g') : null

  const by = (lifecycle: string, memory: string) =>
    candidates.filter((c) => c.evidence.lifecycle === lifecycle && c.evidence.memory === memory)
      .map((c) => ({ evidence: c.evidence, verdict: { eligible: c.eligible, failures: c.failures } }))
  const ceiling = (lifecycle: string, memory: string) => recommendSimultaneous(by(lifecycle, memory))
  const passing768 = lifecycles.some((l) => ceiling(l, '768m') > 0)
  const recommendation = {
    perLifecycle: Object.fromEntries(lifecycles.flatMap((l) => sizes.map((s) => [`${l}@${s}`, ceiling(l, s)]))),
    default: recommendDefault({ passing768m: passing768, ceiling768m: Math.max(0, ...lifecycles.map((l) => ceiling(l, '768m'))), ceiling1g: Math.max(0, ...lifecycles.map((l) => ceiling(l, '1g'))) }),
    scope: 'sustained OpenCode conversation (100 tool-response turns/worker/round, pandas/DuckDB/matplotlib research, 10 rounds) — qualifies the measured workload, not arbitrary future tasks',
  }
  const sustainedReport = {
    measuredAt: new Date().toISOString(),
    image: ctx.image,
    docker: { version, memTotalMiB: mib(memTotal), cpus: Number(ncpu) },
    protocol: { lifecycles, sizes, cpus, rounds: ctx.rounds, turns: ctx.turns, startN, maxReps },
    candidates: candidates.map((c) => ({
      lifecycle: c.evidence.lifecycle, memory: c.evidence.memory, simultaneous: c.evidence.simultaneous,
      admitted: c.admitted, admissionNote: c.admissionNote, hostBefore: c.hostBefore,
      eligible: c.eligible, failures: c.failures,
      repetitions: c.repetitions.map((r) => ({ evidence: r.evidence, rounds: r.rounds, liveBefore: r.liveBefore, liveAfter: r.liveAfter })),
    })),
    recovery,
    recommendation,
  }
  if (values.out) await writeFile(values.out, `${JSON.stringify(sustainedReport, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(recommendation))
}

if (values.mode === 'sustained') {
  await runSustainedBenchmark()
  process.exit(0)
}

