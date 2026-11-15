import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'

// Every `docker exec` the composed run starts is captured here instead of reaching Docker.
const execs = vi.hoisted(() => [] as { args: string[]; env: Record<string, string>; envFile: string | null; envFileText: string | null }[])
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { readFileSync: read } = await import('node:fs')
  const { readFileSync: readFixture } = await import('node:fs')
  const { join: joinPath } = await import('node:path')
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      if (cmd !== 'docker') return actual.spawn(cmd, args, opts as never)
      const at = args.indexOf('--env-file')
      const envFile = at >= 0 ? args[at + 1]! : null
      execs.push({ args, env: opts.env, envFile, envFileText: envFile ? read(envFile, 'utf8') : null })
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242 })
      const stream = readFixture(joinPath(process.cwd(), 'test/fixtures/claude-code-2.1.325/genuine-haiku-ok.jsonl'), 'utf8')
      let first = true
      stdin.on('data', () => { if (first) { first = false; setImmediate(() => stdout.write(stream)) } })
      stdin.on('finish', () => setTimeout(() => { stdout.end(); child.emit('exit', 0, null) }, 5))
      return child
    }),
  }
})

const { composeRun } = await import('../../src/server/compose-run.js')
const { parseRunSpec } = await import('../../src/server/run-spec.js')
const { CapacityLedger } = await import('../../src/runtime/docker/capacity.js')
const { RelayPolicy } = await import('../../src/runtime/provider-relay.js')
const { SubscriptionLimitGate } = await import('../../src/runtime/claude-code/limit-gate.js')

const TOKEN = 'sk-ant-oat01-FAKE-PROTECTED-TOKEN-0123456789abcdef'
const catalogJson = JSON.stringify({ wandb: { api: 'https://api.inference.wandb.ai/v1', npm: '@ai-sdk/openai-compatible', models: {} } })
const authJson = JSON.stringify({ wandb: { type: 'api', key: 'FAKE-WANDB-KEY' } })

describe('a protected run with a Claude subscription agent', () => {
  test('the token reaches only the CLI, through a removed 0600 env file; the CLI goes out through the gateway proxy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compose-claude-prot-'))
    const policy = new RelayPolicy()
    const grant = vi.spyOn(policy, 'grant')
    try {
      const seams = {
        startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
        attachHostServer: vi.fn(),
        ensureImageFn: vi.fn(async () => {}),
        toolchainId: vi.fn(async () => 'abc123def4567890'),
        readImageInventory: vi.fn(async () => ({
          schemaVersion: 1 as const, toolchainId: 'abc123def4567890',
          python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
          tools: ['python3', 'node', 'git', 'opencode', 'rg', 'claude'].map((name) => ({ name, version: '1', executable: `/usr/bin/${name}` })),
          pythonPackages: [],
        })),
        readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 0, cpus: 16, containers: [] })),
        sweepFn: vi.fn(async () => [] as string[]),
        validateModels: vi.fn(async () => {}),
        inspectPath: vi.fn((): 'file' => 'file'),
        ledger: new CapacityLedger(),
        hostModelsFile: vi.fn(() => '/host/models.json'),
        readTextFile: vi.fn(async (p: string) => (p.endsWith('models.json') ? catalogJson : authJson)),
        relay: vi.fn(async () => ({ policy, port: 45678 })),
        createShardNetworkFn: vi.fn(async (runId: string, i: number) => `arena-${runId}-net-${i}`),
        removeShardNetworkFn: vi.fn(async () => true),
        runtimeStateOf: vi.fn(async () => 'stopped' as const),
        inspectContainer: vi.fn(async () => null),
        startShardContainerFn: vi.fn(async (s: { shardIndex: number; runId: string }) => ({
          name: `arena-${s.runId}-${s.shardIndex}`, baseUrl: `http://127.0.0.1:${46000 + s.shardIndex}`, shardIndex: s.shardIndex, gatewayName: `arena-${s.runId}-gw-${s.shardIndex}`,
        })),
        removeContainerFn: vi.fn(async () => {}),
        subscriptions: {
          claudeTokens: { read: async () => TOKEN, has: async () => true, set: async () => {}, clear: async () => true },
          findClaudeCli: () => null,
          claudeHostLogin: async () => ({ loggedIn: false, authMethod: 'none', subscriptionType: null }),
          claudeCliVersion: async () => null,
          claudeLimitGate: new SubscriptionLimitGate(),
          chatGptLogin: () => ({ credentials: async () => ({ access: 'a' }), limited: () => null, noteLimit: () => {} }),
        },
      }
      const c = await composeRun(parseRunSpec({
        name: 'p', goal: 'g', sandbox: 'docker', workspaceRoot: root, authFile: join(root, 'auth.json'), maxContainers: 1,
        roster: [{ modelId: 'claude-subscription/haiku', count: 1, temperature: 0.7 }],
      }), seams as never, { runIdHolder: { value: 'run-c' } })
      const events: unknown[] = []
      c.attachActivity!('run-c', (e) => events.push(e))
      await c.planFor!(['a1'])
      const handle = await c.sandbox.provision('a1', {})
      const result = await c.runner.run(handle, {
        agentId: 'a1', goalMd: 'Say OK', timeoutMs: 60_000,
        genome: { strategyMd: 'Be brief.', notesMd: '', modelId: 'claude-subscription/haiku', temperature: 0.7 },
      })
      expect(result).toMatchObject({ status: 'no_submission', usageKnown: true, costUsd: 0 })

      const exec = execs.at(-1)!
      const at = exec.args.indexOf('arena-run-c-0')
      expect(at).toBeGreaterThan(0)
      // The unmodified CLI, its proxy settings, and an env file, but no token, on the command line.
      expect(exec.args).toEqual(expect.arrayContaining([
        '-e', 'HTTPS_PROXY=http://gateway:8789', '-e', 'NO_PROXY=gateway,localhost,127.0.0.1', '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', '--env-file',
      ]))
      expect(exec.args.slice(at + 1, at + 3)).toEqual(['sh', '-c'])
      expect(exec.args).toContain('--model=haiku')
      expect(exec.args.join(' ')).not.toContain(TOKEN)
      expect(exec.args.some((a) => a.startsWith('ANTHROPIC_BASE_URL'))).toBe(false)
      // The docker client's own environment does not hold it either; only the env file does.
      expect(JSON.stringify(exec.env)).not.toContain(TOKEN)
      expect(exec.envFileText).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`)
      expect(existsSync(exec.envFile!)).toBe(false)
      // Nor anything the relay was granted, the activity the dashboard and audit received, or the result.
      expect(JSON.stringify(grant.mock.calls)).not.toContain(TOKEN)
      expect(events.length).toBeGreaterThan(0)
      expect(JSON.stringify(events)).not.toContain(TOKEN)
      expect(JSON.stringify(result)).not.toContain(TOKEN)
      expect(JSON.stringify(seams.startShardContainerFn.mock.calls)).not.toContain(TOKEN)
      expect(readFileSync(join(root, '.arena-runtime', 'run-c', 'shard-0-config', 'opencode.json'), 'utf8')).not.toContain(TOKEN)
      await c.cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
