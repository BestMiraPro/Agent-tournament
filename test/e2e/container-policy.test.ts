import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { RelayPolicy } from '../../src/runtime/provider-relay.js'
import { startProviderRelay, type ProviderRelay, type UpstreamCall } from '../../src/runtime/provider-relay-server.js'
import { docker } from '../../src/runtime/docker/cli.js'
import { startShardContainer, type ShardContainer } from '../../src/runtime/docker/container.js'
import { ensureImage } from '../../src/runtime/docker/image.js'
import { createShardNetwork, removeShardNetwork } from '../../src/runtime/docker/network.js'
import { agentImageTag, readToolchainId } from '../../src/runtime/tool-manifest.js'
import { hostModelsCatalog } from '../../src/runtime/opencode/discovery.js'
import { relayProviderConfig } from '../../src/runtime/opencode/relay-config.js'

/**
 * The protected runtime's boundaries, exercised against real Docker with harmless fixtures:
 * synthetic credentials, a fake upstream, test-owned files and names. No real provider, no real
 * secret and no arbitrary Internet target is contacted; every "reach" probe is expected to fail.
 *
 * Gated like the other Docker suites: `ARENA_DOCKER_E2E=1`. It builds the toolchain image when
 * missing, which takes minutes the first time.
 */
const ENABLED = process.env.ARENA_DOCKER_E2E === '1'
const d = describe.skipIf(!ENABLED)

const RUN = `policy${Date.now().toString(36)}`
const TOKEN = 'run-token-synthetic-0001'
const UPSTREAM_KEY = 'SYNTHETIC-UPSTREAM-KEY'
const MODEL = 'fake/relay-model'

const upstreamCalls: { url: string; headers: Record<string, string>; body: string }[] = []
const fakeUpstream: UpstreamCall = async (url, init) => {
  upstreamCalls.push({ url, headers: init.headers, body: init.body.toString('utf8') })
  async function* body() {
    yield Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  }
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: body() }
}

let relay: ProviderRelay
let root = ''
const shards: ShardContainer[] = []
const networks: string[] = []

/** Runs a command in a worker as its own unprivileged user, never failing the call itself. */
const inWorker = async (shard: ShardContainer, script: string, timeoutMs = 60_000) =>
  docker(['exec', shard.name, 'sh', '-c', script], timeoutMs)

/** A Python connect probe: prints `open` or the error name, so a refusal is data, not a throw. */
const connectProbe = (host: string, port: number) =>
  `python3 -c "import socket;s=socket.socket();s.settimeout(4)\ntry:\n s.connect(('${host}',${port}));print('open')\nexcept Exception as e:\n print(type(e).__name__)"`

d('protected container policy (ARENA_DOCKER_E2E=1)', () => {
  beforeAll(async () => {
    const toolchainId = await readToolchainId(process.cwd())
    const image = agentImageTag(toolchainId)
    await ensureImage(image, join(process.cwd(), 'docker'), 'docker/Dockerfile.agent', undefined, { toolchainId })

    const catalogue = hostModelsCatalog(process.env, homedir(), existsSync)
    if (!catalogue) throw new Error('No host model catalogue (~/.cache/opencode/models.json): run OpenCode once first.')

    const policy = new RelayPolicy([], { maxRequestBytes: 64 * 1024, maxResponseBytes: 1024 * 1024 })
    policy.grant(RUN, {
      token: TOKEN, allowedModels: [MODEL], maxRequests: 3,
      upstreams: [{ providerId: 'fake', baseUrl: 'https://upstream.invalid/v1', authStyle: 'bearer', apiKey: UPSTREAM_KEY }],
    })
    relay = await startProviderRelay({ policy, upstream: fakeUpstream })

    root = await mkdtemp(join(tmpdir(), 'arena-policy-'))
    const models = await readFile(catalogue, 'utf8')
    for (const shardIndex of [0, 1]) {
      const hostDir = join(root, `shard-${shardIndex}`)
      const toolsDir = join(root, `tools-${shardIndex}`)
      const configDir = join(root, `config-${shardIndex}`)
      for (const dir of [hostDir, toolsDir, configDir]) await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
      await writeFile(join(toolsDir, 'TOOLS.md'), '# fixture\n', 'utf8')
      await writeFile(join(configDir, 'opencode.json'), relayProviderConfig({ providers: ['fake'], relayBaseUrl: 'http://gateway:8787', token: TOKEN }), 'utf8')
      await writeFile(join(configDir, 'models.json'), models, 'utf8')
      await writeFile(join(hostDir, `secret-of-shard-${shardIndex}.txt`), `private to shard ${shardIndex}\n`, 'utf8')

      const network = await createShardNetwork(RUN, shardIndex)
      networks.push(network)
      shards.push(await startShardContainer({
        runId: RUN, shardIndex, image, hostDir, memory: '1g', cpus: 1, authFile: null, toolsDir,
        protectedRuntime: { network, configDir, relayPort: relay.port },
      }, docker, // Bounded per probe, as the app does: one connection held open through the gateway
      // otherwise stalls the whole wait.
      async (baseUrl) => fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)))
    }
  }, 1_800_000)

  afterAll(async () => {
    for (const s of shards) {
      await docker(['rm', '-f', s.name], 30_000)
      if (s.gatewayName) await docker(['rm', '-f', s.gatewayName], 30_000)
    }
    for (const n of networks) await removeShardNetwork(n)
    await relay?.close()
    if (root) await rm(root, { recursive: true, force: true })
  }, 120_000)

  test('the worker runs unprivileged on a read-only system: toolchain and root writes are denied, the workspace is writable', async () => {
    const [a] = shards
    const r = await inWorker(a!, [
      'id -u',
      'touch /opt/arena/venv/injected 2>/dev/null && echo venv-writable || echo venv-denied',
      'touch /usr/local/bin/injected 2>/dev/null && echo bin-writable || echo bin-denied',
      'touch /etc/injected 2>/dev/null && echo etc-writable || echo etc-denied',
      'touch /run/arena/injected 2>/dev/null && echo tools-writable || echo tools-denied',
      'touch /work/ok && echo work-writable',
    ].join('; '))
    expect(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual([
      '1000', 'venv-denied', 'bin-denied', 'etc-denied', 'tools-denied', 'work-writable',
    ])
  })

  test('no provider credential is anywhere the worker can read', async () => {
    const [a] = shards
    const r = await inWorker(a!, 'find / -xdev -name auth.json 2>/dev/null; env | grep -i -E "api_key|token|secret" ; grep -r -l SYNTHETIC-UPSTREAM-KEY /run /home /work /tmp 2>/dev/null; echo done')
    expect(r.stdout.trim()).toBe('done')
    const config = await inWorker(a!, 'cat /run/arena-config/opencode.json')
    expect(config.stdout).toContain(TOKEN)
    expect(config.stdout).not.toContain(UPSTREAM_KEY)
  })

  test('scripts cannot download: no DNS, no direct IP, no host services, no sibling shard', async () => {
    const [a, b] = shards
    const siblingIp = (await docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', b!.name])).stdout.trim().split(' ')[0]!
    const probes = await inWorker(a!, [
      'getent hosts example.com >/dev/null && echo dns-resolves || echo dns-blocked',
      connectProbe('1.1.1.1', 443),
      connectProbe('host.docker.internal', relay.port),
      connectProbe(siblingIp, 4096),
      `python3 -c "import urllib.request\ntry:\n urllib.request.urlopen('https://pypi.org/simple/requests/', timeout=5);print('downloaded')\nexcept Exception as e:\n print('download-blocked')"`,
      `node -e "fetch('https://registry.npmjs.org/').then(()=>console.log('downloaded'),()=>console.log('download-blocked'))"`,
      'pip install --quiet requests >/dev/null 2>&1 && echo pip-installed || echo pip-blocked',
      `ls /work/secret-of-shard-1.txt 2>/dev/null && echo sibling-file-visible || echo sibling-file-absent`,
    ].join('; '), 120_000)
    const lines = probes.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines[0]).toBe('dns-blocked')
    expect(lines.slice(1, 4)).not.toContain('open')
    expect(lines.slice(4)).toEqual(['download-blocked', 'download-blocked', 'pip-blocked', 'sibling-file-absent'])
  }, 180_000)

  test('the approved route works: a model call through the gateway reaches the upstream with the real key only', async () => {
    const [a] = shards
    upstreamCalls.length = 0
    const r = await inWorker(a!, `python3 -c "import urllib.request,json
req=urllib.request.Request('http://gateway:8787/fake/chat/completions',data=json.dumps({'model':'relay-model','messages':[]}).encode(),headers={'Authorization':'Bearer ${TOKEN}','Content-Type':'application/json'})
print(urllib.request.urlopen(req,timeout=20).read().decode())"`)
    expect(r.stdout).toContain('"content":"ok"')
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]!.url).toBe('https://upstream.invalid/v1/chat/completions')
    expect(upstreamCalls[0]!.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(JSON.stringify(upstreamCalls[0])).not.toContain(TOKEN)
  })

  test('misuse is refused at the relay: wrong token, other model, other path, other method, quota', async () => {
    const [a] = shards
    const status = (path: string, token: string, model: string, method = 'POST') =>
      `python3 -c "import urllib.request,urllib.error,json
req=urllib.request.Request('http://gateway:8787${path}',method='${method}',data=None if '${method}'=='GET' else json.dumps({'model':'${model}'}).encode(),headers={'Authorization':'Bearer ${token}','Content-Type':'application/json'})
try:
 print(urllib.request.urlopen(req,timeout=20).status)
except urllib.error.HTTPError as e:
 print(e.code)"`
    upstreamCalls.length = 0
    const r = await inWorker(a!, [
      status('/fake/chat/completions', 'stolen-or-guessed', 'relay-model'),
      status('/fake/chat/completions', TOKEN, 'some-other-model'),
      status('/fake/../admin', TOKEN, 'relay-model'),
      status('/fake/chat/completions', TOKEN, 'relay-model', 'GET'),
      // The grant allows 3 requests and the previous test used one: two more succeed, then 429.
      status('/fake/chat/completions', TOKEN, 'relay-model'),
      status('/fake/chat/completions', TOKEN, 'relay-model'),
      status('/fake/chat/completions', TOKEN, 'relay-model'),
    ].join('; '), 120_000)
    expect(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['401', '403', '404', '405', '200', '200', '429'])
    expect(upstreamCalls).toHaveLength(2)
  }, 180_000)

  test('permitted research computation runs offline in the workspace', async () => {
    const [a] = shards
    const r = await inWorker(a!, `cd /work && cat > test_calc.py <<'EOF'
import numpy as np, pandas as pd, scipy, pyarrow, duckdb, matplotlib
def test_mean():
    df = pd.DataFrame({'r': np.arange(1, 11) / 100})
    assert abs(df.r.mean() - 0.055) < 1e-12
    assert duckdb.sql('select 42').fetchone()[0] == 42
EOF
python -m pytest -q -p no:cacheprovider test_calc.py 2>&1 | tail -1`, 180_000)
    expect(r.stdout).toMatch(/1 passed/)
  }, 240_000)

  test('removing the shard leaves no owned container or network behind', async () => {
    for (const s of shards.splice(0)) {
      await docker(['rm', '-f', s.name], 30_000)
      if (s.gatewayName) await docker(['rm', '-f', s.gatewayName], 30_000)
    }
    for (const n of networks.splice(0)) expect(await removeShardNetwork(n)).toBe(true)
    const left = await docker(['ps', '-a', '--filter', `name=arena-${RUN}`, '--format', '{{.Names}}'])
    const nets = await docker(['network', 'ls', '--filter', `label=arena.run=${RUN}`, '--format', '{{.Name}}'])
    expect(left.stdout.trim()).toBe('')
    expect(nets.stdout.trim()).toBe('')
  }, 120_000)
})
