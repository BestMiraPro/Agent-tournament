import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { composeRun, withFreeProvider } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'
import { CapacityLedger } from '../../src/runtime/docker/capacity.js'
import { RelayPolicy } from '../../src/runtime/provider-relay.js'
import { DispatchingAgentRunner } from '../../src/runtime/dispatch.js'
import { ClaudeCodeAgentRunner } from '../../src/runtime/claude-code/agent-runner.js'
import { SubscriptionLimitGate } from '../../src/runtime/claude-code/limit-gate.js'
import type { SubscriptionServices } from '../../src/server/subscriptions.js'
import type { EngineEvent } from '../../src/engine/events.js'

// Fake credentials only: fixtures, not anyone's login.
const catalogJson = JSON.stringify({
  wandb: { api: 'https://api.inference.wandb.ai/v1', npm: '@ai-sdk/openai-compatible', models: {} },
  openai: { api: null, npm: '@ai-sdk/openai', models: { 'gpt-5.5': { id: 'gpt-5.5', cost: { input: 1.25, output: 10, cache_read: 0.125 } } } },
})
const authJson = JSON.stringify({
  wandb: { type: 'api', key: 'FAKE-WANDB-KEY' },
  openai: { type: 'oauth', refresh: 'FAKE-REFRESH', access: 'FAKE-ACCESS', expires: 1_900_000_000_000, accountId: 'acct' },
})
const inventory = {
  schemaVersion: 1 as const, toolchainId: 'abc123def4567890',
  python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
  tools: ['python3', 'node', 'git', 'opencode', 'rg', 'claude'].map((name) => ({ name, version: '1.0', executable: `/usr/bin/${name}` })),
  pythonPackages: [],
}

function subscriptions(over: { token?: string | null; cli?: string | null; hostLoggedIn?: boolean } = {}): SubscriptionServices {
  const token = over.token === undefined ? 'sk-ant-oat01-FAKE-SETUP-TOKEN-0123456789' : over.token
  return {
    claudeTokens: { read: async () => token, has: async () => token !== null, set: async () => {}, clear: async () => true },
    findClaudeCli: () => (over.cli === undefined ? '/usr/local/bin/claude' : over.cli),
    claudeHostLogin: async () => ({ loggedIn: over.hostLoggedIn ?? false, authMethod: over.hostLoggedIn ? 'claude.ai' : 'none', subscriptionType: null }),
    claudeCliVersion: async () => '2.1.325 (Claude Code)',
    claudeLimitGate: new SubscriptionLimitGate(),
    chatGptLogin: () => ({ credentials: async () => ({ access: 'a' }), limited: () => null, noteLimit: () => {} }) as never,
  }
}

const GiB = 1024 ** 3
function seams(sub: SubscriptionServices, extra: Record<string, unknown> = {}) {
  return {
    startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
    attachHostServer: vi.fn(),
    ensureImageFn: vi.fn(async () => {}),
    toolchainId: vi.fn(async () => 'abc123def4567890'),
    readImageInventory: vi.fn(async () => inventory),
    readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * GiB, usedMemoryBytes: 0, cpus: 16, containers: [] })),
    sweepFn: vi.fn(async () => [] as string[]),
    validateModels: vi.fn(async () => {}),
    inspectPath: vi.fn((): 'file' | 'directory' | 'missing' => 'file'),
    ledger: new CapacityLedger(),
    hostModelsFile: vi.fn(() => '/host/models.json'),
    readTextFile: vi.fn(async (path: string) => (path.endsWith('models.json') ? catalogJson : authJson)),
    relay: vi.fn(async () => ({ policy: new RelayPolicy(), port: 45678 })),
    createShardNetworkFn: vi.fn(async (runId: string, i: number) => `arena-${runId}-net-${i}`),
    removeShardNetworkFn: vi.fn(async () => true),
    runtimeStateOf: vi.fn(async () => 'stopped' as const),
    startShardContainerFn: vi.fn(async (s: { shardIndex: number; runId: string }) => ({
      name: `arena-${s.runId}-${s.shardIndex}`, baseUrl: `http://127.0.0.1:${46000 + s.shardIndex}`, shardIndex: s.shardIndex,
      gatewayName: `arena-${s.runId}-gw-${s.shardIndex}`,
    })),
    removeContainerFn: vi.fn(async () => {}),
    subscriptions: sub,
    ...extra,
  }
}

const roster = [
  { modelId: 'claude-subscription/claude-opus-5-5', count: 1, temperature: 0.7 },
  { modelId: 'openai/gpt-5.5', count: 1, temperature: 0.7 },
]

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'compose-sub-'))
  try {
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('composing runs with subscription models', () => {
  test('a local mixed roster routes Claude agents to Claude Code and the rest to OpenCode, and judges on either', async () => {
    await withRoot(async (root) => {
      const c = await composeRun(parseRunSpec({
        name: 'l', goal: 'g', sandbox: 'local', roster, workspaceRoot: root,
        judge: { modelId: 'claude-subscription/claude-opus-5-5' },
      }), seams(subscriptions()) as never)
      expect(c.runner).toBeInstanceOf(DispatchingAgentRunner)
      const d = c.runner as DispatchingAgentRunner
      expect(d.runnerFor('claude-subscription/claude-opus-5-5')).toBeInstanceOf(ClaudeCodeAgentRunner)
      expect(d.runnerFor('openai/gpt-5.5')).not.toBeInstanceOf(ClaudeCodeAgentRunner)
      expect(c.provider.describe?.('claude-subscription/claude-opus-5-5')).toBe('claude-code')
      expect(c.provider.describe?.('openai/gpt-5.5')).toBe('opencode')
      expect(typeof c.attachActivity).toBe('function')
      await c.cleanup()
    })
  })

  test('host mode is accepted locally when the machine is signed in to a subscription', async () => {
    await withRoot(async (root) => {
      const c = await composeRun(parseRunSpec({ name: 'l', goal: 'g', sandbox: 'local', roster, workspaceRoot: root }),
        seams(subscriptions({ token: null, hostLoggedIn: true })) as never)
      await c.cleanup()
    })
  })

  test('refuses before anything starts when the CLI is missing, or nobody is signed in', async () => {
    await withRoot(async (root) => {
      const spec = parseRunSpec({ name: 'l', goal: 'g', sandbox: 'local', roster, workspaceRoot: root })
      const noCli = seams(subscriptions({ cli: null }))
      await expect(composeRun(spec, noCli as never)).rejects.toThrow(/Claude Code CLI is not installed on this machine.*claude-subscription\/claude-opus-5-5/)
      expect(noCli.startHostServer).not.toHaveBeenCalled()
      await expect(composeRun(spec, seams(subscriptions({ token: null, hostLoggedIn: false })) as never)).rejects.toThrow(/not signed in: run `claude setup-token`/)
    })
  })

  test('Docker needs a setup token for Claude agents, the host login does not reach containers', async () => {
    await withRoot(async (root) => {
      const spec = parseRunSpec({ name: 'd', goal: 'g', sandbox: 'docker', workflow: 'tournament', isolation: 'shared', roster, workspaceRoot: root, authFile: join(root, 'auth.json') })
      await expect(composeRun(spec, seams(subscriptions({ token: null, hostLoggedIn: true })) as never)).rejects.toThrow(/in Docker need a `claude setup-token` value/)
    })
  })

  test('shared Docker mounts the credentials file for the ChatGPT login and warns that a refresh there cannot be saved', async () => {
    await withRoot(async (root) => {
      const s = seams(subscriptions())
      const c = await composeRun(parseRunSpec({
        name: 'd', goal: 'g', sandbox: 'docker', workflow: 'tournament', isolation: 'shared', roster, workspaceRoot: root, authFile: join(root, 'auth.json'),
      }), s as never, { runIdHolder: { value: 'run-s' } })
      await c.planFor!(['a1', 'a2'])
      await c.sandbox.provision('a1', {})
      const [shard] = s.startShardContainerFn.mock.calls[0] as unknown as [{ authFile: string | null; protectedRuntime?: unknown }]
      expect(shard.authFile).toBe(join(root, 'auth.json'))
      expect(shard.protectedRuntime).toBeUndefined()
      expect(c.warnings.join('\n')).toMatch(/cannot save a refreshed ChatGPT token.*Protected isolation refreshes it on the host/)
      await c.cleanup()
    })
  })

  test('protected Docker: the relay carries ChatGPT only; Claude agents get the CONNECT egress route, and the relay never sees the Claude token', async () => {
    await withRoot(async (root) => {
      const policy = new RelayPolicy()
      const grant = vi.spyOn(policy, 'grant')
      const s = seams(subscriptions(), { relay: vi.fn(async () => ({ policy, port: 45678 })) })
      const c = await composeRun(parseRunSpec({
        name: 'p', goal: 'g', sandbox: 'docker', workflow: 'tournament', roster, workspaceRoot: root, authFile: join(root, 'auth.json'), maxContainers: 2,
      }), s as never, { runIdHolder: { value: 'run-p' } })
      const [, g] = grant.mock.calls[0]!
      expect(g.allowedModels).toEqual(['openai/gpt-5.5'])
      expect(g.upstreams!.map((u) => [u.providerId, u.kind, u.baseUrl])).toEqual([['openai', 'chatgpt', 'https://chatgpt.com/backend-api/codex/responses']])
      expect(JSON.stringify(grant.mock.calls)).not.toMatch(/sk-ant|FAKE-SETUP-TOKEN/)
      await c.planFor!(['a1', 'a2'])
      await Promise.all([c.sandbox.provision('a1', {}), c.sandbox.provision('a2', {})])
      const shards = s.startShardContainerFn.mock.calls.map((call) => (call as unknown as [{ protectedRuntime: { configDir: string; claudeEgress?: boolean } }])[0])
      for (const shard of shards) expect(shard.protectedRuntime.claudeEgress).toBe(true)
      // Nothing the host hands Docker, writes for workers, or keeps about the run holds the token.
      expect(JSON.stringify(s.startShardContainerFn.mock.calls)).not.toMatch(/sk-ant|FAKE-SETUP-TOKEN/)
      const opencodeJson = readFileSync(join(shards[0]!.protectedRuntime.configDir, 'opencode.json'), 'utf8')
      expect(Object.keys(JSON.parse(opencodeJson).provider)).toEqual(['openai'])
      expect(opencodeJson).not.toMatch(/FAKE-|sk-ant/)
      const manifests = readdirSync(join(root, '.arena-runtime', 'run-p'), { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile()).map((d) => readFileSync(join(d.parentPath, d.name), 'utf8'))
      expect(manifests.length).toBeGreaterThan(0)
      for (const text of manifests) expect(text).not.toMatch(/sk-ant|FAKE-SETUP-TOKEN/)
      expect(JSON.stringify(c.config)).not.toMatch(/sk-ant|FAKE-SETUP-TOKEN/)
      expect(c.warnings.join('\n')).not.toMatch(/sk-ant|FAKE-SETUP-TOKEN/)
      const models = JSON.parse(readFileSync(join(shards[0]!.protectedRuntime.configDir, 'models.json'), 'utf8'))
      expect(models.openai.models['gpt-5.5'].cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
      expect(models.wandb).toEqual(JSON.parse(catalogJson).wandb)
      await c.cleanup()
    })
  })

  test('protected Docker accepts Claude aliases again: nothing on the host matches the model', async () => {
    await withRoot(async (root) => {
      const s = seams(subscriptions())
      const c = await composeRun(parseRunSpec({
        name: 'p', goal: 'g', sandbox: 'docker', workflow: 'tournament', workspaceRoot: root, authFile: join(root, 'auth.json'), maxContainers: 1,
        roster: [{ modelId: 'claude-subscription/opus', count: 1, temperature: 0.7 }],
      }), s as never, { runIdHolder: { value: 'run-a' } })
      await c.cleanup()
    })
  })

  test('a protected run without Claude agents starts no egress route', async () => {
    await withRoot(async (root) => {
      const s = seams(subscriptions())
      const c = await composeRun(parseRunSpec({
        name: 'p', goal: 'g', sandbox: 'docker', workflow: 'tournament', workspaceRoot: root, authFile: join(root, 'auth.json'), maxContainers: 1,
        roster: [{ modelId: 'openai/gpt-5.5', count: 1, temperature: 0.7 }],
      }), s as never, { runIdHolder: { value: 'run-o' } })
      await c.planFor!(['a1'])
      await c.sandbox.provision('a1', {})
      const [shard] = s.startShardContainerFn.mock.calls[0] as unknown as [{ protectedRuntime: { claudeEgress?: boolean } }]
      expect(shard.protectedRuntime.claudeEgress).toBeUndefined()
      await c.cleanup()
    })
  })

  test('Claude activity reaches the attached sink as ordinary agent activity', async () => {
    await withRoot(async (root) => {
      const c = await composeRun(parseRunSpec({ name: 'l', goal: 'g', sandbox: 'local', roster, workspaceRoot: root }), seams(subscriptions()) as never)
      const events: EngineEvent[] = []
      const detach = c.attachActivity!('run-1', (e) => events.push(e))
      const runner = (c.runner as DispatchingAgentRunner).runnerFor('claude-subscription/x') as unknown as { options: { onActivity: (a: string, x: unknown) => void } }
      runner.options.onActivity('a1', { kind: 'text', detail: 'hi', item: { id: 't', sessionId: 's', kind: 'text', summary: 'hi', observedAt: 1 } })
      detach()
      runner.options.onActivity('a1', { kind: 'text', detail: 'late', item: { id: 'u', sessionId: 's', kind: 'text', summary: 'late', observedAt: 2 } })
      expect(events).toEqual([{ type: 'agent.activity', runId: 'run-1', agentId: 'a1', kind: 'text', detail: 'hi', item: { id: 't', sessionId: 's', kind: 'text', summary: 'hi', observedAt: 1 } }])
      await c.cleanup()
    })
  })

  test('withFreeProvider zeroes one provider and leaves the rest', () => {
    const out = JSON.parse(withFreeProvider(JSON.parse(catalogJson), 'openai'))
    expect(out.openai.models['gpt-5.5']).toEqual({ id: 'gpt-5.5', cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } })
  })
})
