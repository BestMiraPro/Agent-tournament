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
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { docker } from '../src/runtime/docker/cli.js'
import { hostModelsCatalog } from '../src/runtime/opencode/discovery.js'
import { agentImageTag, readToolchainId } from '../src/runtime/tool-manifest.js'

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
