import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { ToolBridge, type ConnectorEvent } from '../../src/connectors/bridge.js'
import type { ConnectorResolver, ResolvedConnector } from '../../src/connectors/resolve.js'
import { connectInProcess } from '../../src/connectors/upstream.js'
import type { ConnectorKind, ToolPolicy } from '../../src/connectors/types.js'
import { CapacityLedger } from '../../src/runtime/docker/capacity.js'
import { RelayPolicy } from '../../src/runtime/provider-relay.js'
import { composeRun } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

/** Stands in for a connector credential: it must never leave the host side. */
const CONNECTOR_SECRET = 'ghp_SYNTHETIC-CONNECTOR-SECRET-0001'
const catalogJson = JSON.stringify({ wandb: { api: 'https://api.inference.wandb.ai/v1', npm: '@ai-sdk/openai-compatible', models: {} } })
const authJson = JSON.stringify({ wandb: { type: 'api', key: 'FAKE-WANDB-KEY' } })
const GiB = 1024 ** 3

const roots: string[] = []
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'compose-connectors-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A fake upstream whose server closure holds the "credential", the way a real connector holds its token. */
function fakeConnector(id: string, kind: ConnectorKind | 'builtin', opts: { policy?: ToolPolicy; fail?: boolean; closed?: string[] } = {}): ResolvedConnector {
  return {
    id, title: `Fake ${id}`, kind, policy: opts.policy ?? { disabledTools: [], writeTools: [] }, perAgent: kind === 'builtin',
    open: async () => {
      if (opts.fail) throw new Error(`connection refused (token=${CONNECTOR_SECRET})`)
      const server = new McpServer({ name: id, version: '1' })
      const credential = CONNECTOR_SECRET
      server.registerTool('search_things', { description: 'Search things.\nMore detail.', inputSchema: { q: z.string().optional() }, annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: 'text', text: credential.length > 0 ? 'found' : '' }] }))
      server.registerTool('send_things', { inputSchema: {}, annotations: { readOnlyHint: false } }, async () => ({ content: [{ type: 'text', text: 'sent' }] }))
      const upstream = await connectInProcess(server)
      return { ...upstream, close: async () => { opts.closed?.push(id); await upstream.close() } }
    },
  }
}

const resolverOf = (...connectors: ResolvedConnector[]): ConnectorResolver & { storeDir: string | null } => ({
  storeDir: null,
  resolve: (id) => connectors.find((c) => c.id === id) ?? null,
})

function seams(over: Record<string, unknown> = {}) {
  return {
    startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
    attachHostServer: vi.fn(),
    ensureImageFn: vi.fn(async () => {}),
    toolchainId: vi.fn(async () => 'abc123def4567890'),
    readImageInventory: vi.fn(async () => ({
      schemaVersion: 1 as const, toolchainId: 'abc123def4567890',
      python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
      tools: ['python3', 'node', 'git', 'opencode', 'rg'].map((name) => ({ name, version: '1.0', executable: `/usr/bin/${name}` })),
      pythonPackages: [],
    })),
    readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * GiB, usedMemoryBytes: 0, cpus: 16, containers: [] })),
    sweepFn: vi.fn(async () => [] as string[]),
    validateModels: vi.fn(async () => {}),
    inspectPath: vi.fn((): 'file' | 'directory' | 'missing' => 'file'),
    ledger: new CapacityLedger(),
    hostModelsFile: vi.fn(() => '/host/models.json'),
    readTextFile: vi.fn(async (path: string) => (path.endsWith('models.json') ? catalogJson : authJson)),
    relay: vi.fn(async () => ({ policy: new RelayPolicy(), port: 45678 })),
    toolBridge: vi.fn(async () => ({ bridge, port: 45679, host: '127.0.0.1' })),
    createShardNetworkFn: vi.fn(async (runId: string, i: number) => `arena-${runId}-net-${i}`),
    removeShardNetworkFn: vi.fn(async () => true),
    runtimeStateOf: vi.fn(async () => 'stopped' as const),
    startShardContainerFn: vi.fn(async (s: { shardIndex: number; runId: string }) => ({
      name: `arena-${s.runId}-${s.shardIndex}`, baseUrl: `http://127.0.0.1:${46000 + s.shardIndex}`, shardIndex: s.shardIndex,
      gatewayName: `arena-${s.runId}-gw-${s.shardIndex}`, network: `arena-${s.runId}-net-${s.shardIndex}`,
    })),
    removeContainerFn: vi.fn(async () => {}),
    createShardClient: vi.fn(() => ({ health: async () => true, providers: async () => ({ all: [], default: {} }), version: async () => '1.18.21' })),
    ...over,
  }
}

let bridge = new ToolBridge()

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/** The runner's per-agent OpenCode config, as it would write it into the agent's workspace. */
const projectConfigOf = (runner: unknown, agentId: string): string | null =>
  ((runner as { options: { projectConfig?: (h: { agentId: string }) => string | null } }).options.projectConfig?.({ agentId }) ?? null)

describe('a run with connectors', () => {
  test('protected docker: workers reach the bridge through the gateway with their own token, and hold no credential', async () => {
    bridge = new ToolBridge()
    const root = tempRoot()
    const closed: string[] = []
    const s = seams({ connectors: () => resolverOf(fakeConnector('gh', 'github', { closed })) })
    const c = await composeRun(parseRunSpec({
      name: 'p', goal: 'g', sandbox: 'docker', roster: [{ modelId: 'wandb/zai-org/GLM-5.2', count: 2, temperature: 0.7 }],
      workspaceRoot: root, authFile: join(root, 'auth.json'), maxContainers: 2, connectors: [{ id: 'gh' }],
    }), s as never, { runIdHolder: { value: 'run-9' } })
    expect(c.config.connectors).toEqual([{ id: 'gh', writeTools: [] }])

    const configA = JSON.parse(projectConfigOf(c.runner, 'a1')!)
    const configB = JSON.parse(projectConfigOf(c.runner, 'a2')!)
    expect(configA.mcp.gh).toMatchObject({ type: 'remote', url: 'http://gateway:8788/mcp/gh', enabled: true, oauth: false })
    const tokenA = configA.mcp.gh.headers.Authorization.replace('Bearer ', '')
    expect(tokenA).not.toBe(configB.mcp.gh.headers.Authorization.replace('Bearer ', ''))
    expect(bridge.authenticate(tokenA)).toEqual({ grantId: expect.any(String), agentId: 'a1' })

    await c.planFor!(['a1', 'a2'])
    await Promise.all([c.sandbox.provision('a1', {}), c.sandbox.provision('a2', {})])
    const tools = readFileSync(join(root, '.arena-runtime', 'run-9', 'shard-0', 'TOOLS.md'), 'utf8')
    expect(tools).toContain('## Connectors')
    expect(tools).toContain('`gh_search_things` — Search things.')
    expect(tools).not.toContain('send_things')

    // Calls are attributed to the agent by token, carry the live run id, and the read-only lock holds.
    const events: ConnectorEvent[] = []
    c.onConnectorEvent!((e) => events.push(e))
    const caller = bridge.authenticate(tokenA)!
    expect((await bridge.callTool(caller, 'gh', 'search_things', { q: 'x' })).isError ?? false).toBe(false)
    expect((await bridge.callTool(caller, 'gh', 'send_things', {})).isError).toBe(true)
    expect(events.map((e) => [e.runId, e.agentId, e.call?.tool, e.call?.status])).toEqual([
      ['run-9', 'a1', 'search_things', 'ok'],
      ['run-9', 'a1', 'send_things', 'refused'],
    ])

    // Nowhere a worker can see: written files, container specs, events.
    const everything = [
      ...walk(root).map((f) => readFileSync(f, 'utf8')),
      JSON.stringify(s.startShardContainerFn.mock.calls),
      JSON.stringify(events),
      JSON.stringify(c.config),
      projectConfigOf(c.runner, 'a1')!,
    ].join('\n')
    expect(everything).not.toContain(CONNECTOR_SECRET)

    await c.cleanup()
    expect(bridge.authenticate(tokenA)).toBeNull()
    expect(closed).toEqual(['gh'])
  })

  test('local: agents reach the bridge where it listens', async () => {
    bridge = new ToolBridge()
    const root = tempRoot()
    const c = await composeRun(parseRunSpec({
      name: 'l', goal: 'g', sandbox: 'local', roster: [{ modelId: 'wandb/m', count: 1, temperature: 0.7 }],
      workspaceRoot: root, connectors: [{ id: 'gh' }],
    }), seams({ connectors: () => resolverOf(fakeConnector('gh', 'custom')) }) as never, { runIdHolder: { value: 'run-l' } })
    expect(JSON.parse(projectConfigOf(c.runner, 'a1')!).mcp.gh.url).toBe('http://127.0.0.1:45679/mcp/gh')
    await c.cleanup()
  })

  test('shared docker: agents reach the bridge through the host alias, or the app\'s bridge address', async () => {
    bridge = new ToolBridge()
    const root = tempRoot()
    const spec = parseRunSpec({
      name: 's', goal: 'g', sandbox: 'docker', isolation: 'shared', roster: [{ modelId: 'wandb/m', count: 1, temperature: 0.7 }],
      workspaceRoot: root, authFile: join(root, 'auth.json'), connectors: [{ id: 'gh' }],
    })
    const loop = await composeRun(spec, seams({ connectors: () => resolverOf(fakeConnector('gh', 'custom')) }) as never)
    expect(JSON.parse(projectConfigOf(loop.runner, 'a1')!).mcp.gh.url).toBe('http://host.docker.internal:45679/mcp/gh')
    await loop.cleanup()
    const viaBridge = await composeRun(spec, seams({
      connectors: () => resolverOf(fakeConnector('gh', 'custom')),
      toolBridge: vi.fn(async () => ({ bridge, port: 45679, host: '172.17.0.2', gatewayHost: '172.17.0.2' })),
    }) as never)
    expect(JSON.parse(projectConfigOf(viaBridge.runner, 'a1')!).mcp.gh.url).toBe('http://172.17.0.2:45679/mcp/gh')
    await viaBridge.cleanup()
  })

  test('without connectors nothing is written for them', async () => {
    const root = tempRoot()
    const c = await composeRun(parseRunSpec({
      name: 'l', goal: 'g', sandbox: 'local', roster: [{ modelId: 'wandb/m', count: 1, temperature: 0.7 }], workspaceRoot: root,
    }), seams() as never)
    expect(projectConfigOf(c.runner, 'a1')).toBeNull()
    expect(c.onConnectorEvent).toBeUndefined()
    await c.cleanup()
  })
})

describe('connector refusals at composition', () => {
  const local = (root: string, connectors: unknown) => parseRunSpec({
    name: 'l', goal: 'g', sandbox: 'local', roster: [{ modelId: 'wandb/m', count: 1, temperature: 0.7 }], workspaceRoot: root, connectors,
  })

  test('an unknown connector, a write opt-in on a locked one, or an opt-in the connector does not permit', async () => {
    const root = tempRoot()
    const s = seams({
      connectors: () => resolverOf(
        fakeConnector('slack', 'slack'),
        fakeConnector('gh', 'github', { policy: { disabledTools: [], writeTools: ['create_issue'] } }),
        fakeConnector('web', 'builtin'),
      ),
    })
    await expect(composeRun(local(root, [{ id: 'nope' }]), s as never)).rejects.toThrow(/Connector "nope" does not exist/)
    await expect(composeRun(local(root, [{ id: 'slack', writeTools: ['send_message'] }]), s as never)).rejects.toThrow(/read-only: no write tool/)
    await expect(composeRun(local(root, [{ id: 'web', writeTools: ['x'] }]), s as never)).rejects.toThrow(/read-only: no write tool/)
    await expect(composeRun(local(root, [{ id: 'gh', writeTools: ['merge_pull_request'] }]), s as never)).rejects.toThrow(/does not permit the write tool merge_pull_request/)
  })

  test('a connector that cannot connect refuses the run by name, redacted, and closes what was opened', async () => {
    const root = tempRoot()
    const closed: string[] = []
    const s = seams({ connectors: () => resolverOf(fakeConnector('ok', 'custom', { closed }), fakeConnector('bad', 'custom', { fail: true })) })
    let message = ''
    try {
      await composeRun(local(root, [{ id: 'ok' }, { id: 'bad' }]), s as never)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/Fake bad could not connect/)
    expect(message).not.toContain('SYNTHETIC-CONNECTOR-SECRET')
    expect(closed).toEqual(['ok'])
  })

  test('connectors need the dashboard, and no run folder may overlap the store', async () => {
    const root = tempRoot()
    await expect(composeRun(local(root, [{ id: 'gh' }]), seams() as never)).rejects.toThrow(/not available here/)
    const store = join(root, 'connectors')
    const s = seams({ connectors: () => ({ storeDir: store, resolve: () => null }), inspectPath: vi.fn(() => 'directory' as const) })
    await expect(composeRun(parseRunSpec({
      name: 'l', goal: 'g', sandbox: 'local', roster: [{ modelId: 'wandb/m', count: 1, temperature: 0.7 }],
      workspaceRoot: join(root, 'ws'), seedDir: root,
    }), s as never)).rejects.toThrow(/seed folder .* overlaps the connector store/)
  })
})
