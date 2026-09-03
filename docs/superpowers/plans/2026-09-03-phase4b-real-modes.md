# Phase 4b: Real Modes + Run Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive real (local/docker) tournaments from the dashboard with a run-setup screen and safe per-run composition.

**Architecture:** A pure Zod run-spec validator plus a shared `compose-run` module (reusing CLI's `resolveSandboxMode`, `makeClientResolver`, `assertHostCapacity`, `sweepBeforeRun`, `validateRosterModels`) replace the server's single global mock engine with per-run engine+manager records; one shared `EventBroadcaster` fans out, bridges subscribe per endpoint. No engine, judge, evolution, or sandbox behavior changes — composition only.

**Tech Stack:** TypeScript 5, Node 24, Fastify 5, `ws` 8, Zod 3, React 19, Vite 8, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-phase4b-real-modes-design.md`

## Global Constraints

- EngineEvent is defined once in `src/engine/events.ts` and consumed unchanged by every task.
- RunSnapshot shape stays mirrored between `src/server/state.ts` and `web/src/api.ts`; the web bundle never imports server code.
- The OpenCode `?directory=` parameter is REQUIRED on every event subscription; without it only heartbeats arrive and the grid shows nothing.
- A throwing subscriber never fails a tournament round; a busy run rejects concurrent round/config with 409.
- Existing tests keep passing unchanged; real-mode e2e skips without Docker/credentials following the existing e2e-skip pattern.
- `npm test` green (2 pre-existing e2e skips), `npm run typecheck` exit 0, `npm run web:build` exit 0.

---

## File structure

| Path | Responsibility |
|---|---|
| `src/server/run-spec.ts` | Zod run-spec schema plus pure validation (population sum, docker requirements). Pure. |
| `src/server/compose-run.ts` | Shared mock/local/docker composition used by server (and CLI delegation). |
| `src/server/runs.ts` | Per-run registry: runId to engine, manager, bridges, warnings, capacity. |
| `src/server/api.ts` | POST full spec, PATCH config, snapshot gains (modified, backward compatible). |
| `src/server/state.ts` | Snapshot gains sandbox/roster/capacity/warnings (modified). |
| `src/db/repos.ts` | `runs.updateConfig` (modified, one method plus test). |
| `src/server/index.ts` | Per-run composition root with new CLI flags (modified). |
| `src/cli.ts` | Delegates real-infra build to `compose-run` (modified, no behavior change). |
| `web/src/api.ts` | Full-spec create plus patchConfig client (modified). |
| `web/src/components/RunSetup.tsx` | Run-setup screen (created). |
| `web/src/App.tsx` | Setup-first flow (modified). |

---

## Task 1: Run-spec schema and validation

**Files:**
- Create: `src/server/run-spec.ts`
- Test: `test/server/run-spec.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CONFIG`, `RosterEntry`, `RunConfig` from `../core/types.js`; `z` from `zod`.
- Produces: `RunSpec` (inferred type), `parseRunSpec(input: unknown): RunSpec` (throws on invalid), `validateRunSpec(spec: RunSpec): string[]` (warnings, non-fatal) used by Tasks 3 and 6.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { parseRunSpec } from '../../src/server/run-spec.js'

const base = {
  name: 'demo',
  goal: 'write a haiku',
  sandbox: 'mock',
  roster: [{ modelId: 'mock/model', count: 4, temperature: 0.7 }],
}

describe('parseRunSpec', () => {
  test('accepts a minimal mock spec', () => {
    const s = parseRunSpec(base)
    expect(s.population).toBe(4)
    expect(s.sandbox).toBe('mock')
  })

  test('population is the roster sum', () => {
    const s = parseRunSpec({
      ...base,
      roster: [
        { modelId: 'a/m', count: 3, temperature: 0.7 },
        { modelId: 'b/m', count: 2, temperature: 0.8 },
      ],
    })
    expect(s.population).toBe(5)
  })

  test('rejects an empty roster', () => {
    expect(() => parseRunSpec({ ...base, roster: [] })).toThrow(/roster/i)
  })

  test('rejects a roster entry with count zero', () => {
    expect(() =>
      parseRunSpec({ ...base, roster: [{ modelId: 'a/m', count: 0, temperature: 0.7 }] }),
    ).toThrow(/count/i)
  })

  test('docker requires a workspaceRoot', () => {
    expect(() => parseRunSpec({ ...base, sandbox: 'docker' })).toThrow(/workspaceRoot/i)
  })

  test('docker requires an authFile', () => {
    expect(() =>
      parseRunSpec({ ...base, sandbox: 'docker', workspaceRoot: '/tmp/w' }),
    ).toThrow(/authFile/i)
  })

  test('local requires a workspaceRoot', () => {
    expect(() => parseRunSpec({ ...base, sandbox: 'local' })).toThrow(/workspaceRoot/i)
  })

  test('unknown sandbox is rejected', () => {
    expect(() => parseRunSpec({ ...base, sandbox: 'lxc' })).toThrow(/sandbox/i)
  })

  test('judge and budget fall back to defaults', () => {
    const s = parseRunSpec(base)
    expect(s.judge.modelId).toBeTruthy()
    expect(s.budget.maxAgentTokens).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/run-spec.test.ts`
Expected: FAIL — cannot resolve `run-spec.js`.

- [ ] **Step 3: Implement**

```typescript
import { z } from 'zod'
import { DEFAULT_CONFIG } from '../core/types.js'

const rosterEntry = z.object({
  modelId: z.string().min(1),
  count: z.number().int().min(1),
  temperature: z.number().min(0).max(2),
})

const schema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  sandbox: z.enum(['mock', 'local', 'docker']).default('mock'),
  roster: z.array(rosterEntry).min(1),
  judge: z
    .object({
      modelId: z.string().min(1),
      mode: z.enum(['auto', 'single_call', 'batched_finals']).default('auto'),
    })
    .partial()
    .default({}),
  reflect: z
    .object({ modelId: z.string().min(1), topK: z.number().int().min(1) })
    .partial()
    .default({}),
  budget: z
    .object({
      maxRunTokens: z.number().int().positive(),
      maxRoundTokens: z.number().int().positive(),
      maxAgentTokens: z.number().int().positive(),
    })
    .partial()
    .default({}),
  seedDir: z.string().nullable().default(null),
  workspaceRoot: z.string().nullable().default(null),
  authFile: z.string().nullable().default(null),
  serverUrl: z.string().nullable().default(null),
  criteria: z.string().nullable().default(null),
})

export type RunSpecInput = z.input<typeof schema>

export interface RunSpec {
  name: string
  goal: string
  sandbox: 'mock' | 'local' | 'docker'
  roster: { modelId: string; count: number; temperature: number }[]
  population: number
  judge: { modelId: string; mode: 'auto' | 'single_call' | 'batched_finals' }
  reflect: { modelId: string; topK: number }
  budget: { maxRunTokens: number; maxRoundTokens: number; maxAgentTokens: number }
  seedDir: string | null
  workspaceRoot: string | null
  authFile: string | null
  serverUrl: string | null
  criteria: string | null
}

/**
 * Parse and cross-validate a run-spec. Field shapes come from Zod;
 * cross-field rules live here so both the API and the web client share them.
 * Docker refuses without workspaceRoot AND authFile: containers without
 * credentials fail every agent on its first model call, so accepting the
 * spec would burn setup time for a run that cannot score. (The CLI only
 * warns here; the server refuses — spending through an API needs the guard.)
 */
export function parseRunSpec(input: unknown): RunSpec {
  const p = schema.parse(input)
  if (p.sandbox === 'docker' && !p.workspaceRoot) {
    throw new Error('docker sandbox requires workspaceRoot')
  }
  if (p.sandbox === 'docker' && !p.authFile) {
    throw new Error('docker sandbox requires authFile')
  }
  if (p.sandbox === 'local' && !p.workspaceRoot) {
    throw new Error('local sandbox requires workspaceRoot')
  }
  const population = p.roster.reduce((n, r) => n + r.count, 0)
  return {
    name: p.name,
    goal: p.goal,
    sandbox: p.sandbox,
    roster: p.roster,
    population,
    judge: {
      modelId: p.judge.modelId ?? DEFAULT_CONFIG.judge.modelId,
      mode: p.judge.mode ?? 'auto',
    },
    reflect: {
      modelId: p.reflect.modelId ?? DEFAULT_CONFIG.reflect.modelId,
      topK: p.reflect.topK ?? DEFAULT_CONFIG.reflect.topK,
    },
    budget: {
      maxRunTokens: p.budget.maxRunTokens ?? DEFAULT_CONFIG.budget.maxRunTokens,
      maxRoundTokens: p.budget.maxRoundTokens ?? DEFAULT_CONFIG.budget.maxRoundTokens,
      maxAgentTokens: p.budget.maxAgentTokens ?? DEFAULT_CONFIG.budget.maxAgentTokens,
    },
    seedDir: p.seedDir,
    workspaceRoot: p.workspaceRoot,
    authFile: p.authFile,
    serverUrl: p.serverUrl,
    criteria: p.criteria,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server/run-spec.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/run-spec.ts test/server/run-spec.test.ts
git commit -m "feat: add the dashboard run-spec validator"
```

---

## Task 2: Shared run composition

**Files:**
- Create: `src/server/compose-run.ts`
- Test: `test/server/compose-run.test.ts`
- Modify: `src/cli.ts` (delegate only, no behavior change)

**Interfaces:**
- Consumes: `RunSpec` from `./run-spec.js`; `resolveSandboxMode`, `makeClientResolver`, `assertHostCapacity`, `sweepBeforeRun`, `validateRosterModels`, `AGENT_IMAGE` from `../cli.js`; `MockAgentRunner`/`MockProvider`/`MockSandbox`, `LocalSandbox`, `DockerSandbox`, `OpenCodeClient`, `OpenCodeProvider`, `OpenCodeAgentRunner`, `attachServer`/`startServer`, `ensureImage`, `startShardContainer`, `removeContainer`, `Judge`, `Reflector` (same imports CLI uses today).
- Produces: `ComposedRun` (`{ sandbox, provider, runner, planFor, serverHandle, sessionMap, warnings, capacity }`) and `composeRun(spec, seams)` used by Tasks 3 and 5; CLI's private builder delegates to it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test, vi } from 'vitest'
import { composeRun } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

const mockSeams = () => ({
  startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn() })),
  attachHostServer: vi.fn(),
  ensureImageFn: vi.fn(async () => {}),
  readCapacity: vi.fn(async () => ({ memoryBytes: 8 * 1024 ** 3, cpuCount: 8 })),
  sweepFn: vi.fn(async () => [] as string[]),
  validateModels: vi.fn(async () => {}),
})

describe('composeRun', () => {
  test('mock mode needs no server or capacity checks', async () => {
    const seams = mockSeams()
    const c = await composeRun(parseRunSpec({
      name: 'm', goal: 'g', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
    }), seams as never)
    expect(c.warnings).toEqual([])
    expect(seams.startHostServer).not.toHaveBeenCalled()
    expect(seams.readCapacity).not.toHaveBeenCalled()
    expect(c.planFor).toBeNull()
  })

  test('docker without capacity fails before spending', async () => {
    const seams = mockSeams()
    seams.readCapacity.mockResolvedValueOnce({ memoryBytes: 100, cpuCount: 1 })
    await expect(composeRun(parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker',
      roster: [{ modelId: 'w/m', count: 4, temperature: 0.7 }],
      workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
    }), seams as never)).rejects.toThrow(/docker sandbox/i)
  })

  test('a failing worker model warns instead of throwing', async () => {
    const seams = mockSeams()
    seams.validateModels.mockImplementationOnce(async () => {
      throw new Error('worker w/bad failed')
    })
    const c = await composeRun(parseRunSpec({
      name: 'w', goal: 'g', sandbox: 'local',
      roster: [{ modelId: 'w/bad', count: 2, temperature: 0.7 }],
      workspaceRoot: '/tmp/w',
    }), { ...seams, validateModels: (async () => {}) as never } as never)
    expect(c.warnings).toEqual([])
  })

  test('session hook fills the session map', async () => {
    const seams = mockSeams()
    const c = await composeRun(parseRunSpec({
      name: 'm', goal: 'g', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 1, temperature: 0.7 }],
    }), seams as never)
    c.sessionHook('agent-1', 'ses_1')
    expect(c.sessionMap.get('ses_1')).toBe('agent-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/compose-run.test.ts`
Expected: FAIL — cannot resolve `compose-run.js`.

- [ ] **Step 3: Implement `src/server/compose-run.ts`**

```typescript
import { DEFAULT_CONFIG, type RunConfig } from '../core/types.js'
import type { Provider } from '../runtime/provider.js'
import type { AgentRunner } from '../runtime/agent-runner.js'
import { MockAgentRunner } from '../runtime/agent-runner.js'
import { MockProvider } from '../runtime/mock-provider.js'
import { MockSandbox } from '../runtime/mock-sandbox.js'
import { LocalSandbox } from '../runtime/local-sandbox.js'
import type { Sandbox } from '../runtime/sandbox.js'
import { OpenCodeAgentRunner } from '../runtime/opencode/agent-runner.js'
import { OpenCodeClient } from '../runtime/opencode/client.js'
import { OpenCodeProvider } from '../runtime/opencode/provider.js'
import { attachServer, startServer, type ServerHandle } from '../runtime/opencode/server.js'
import { AGENT_IMAGE, assertHostCapacity, makeClientResolver, sweepBeforeRun } from '../cli.js'
import { ensureImage } from '../runtime/docker/image.js'
import { startShardContainer } from '../runtime/docker/container.js'
import { removeContainer } from '../runtime/docker/cli.js'
import { DockerSandbox } from '../runtime/docker/sandbox.js'
import type { RunSpec } from './run-spec.js'

export interface ComposeSeams {
  startHostServer: (opts: { timeoutMs: number }) => Promise<ServerHandle>
  attachHostServer: (url: string, timeoutMs: number) => Promise<ServerHandle>
  ensureImageFn: (image: string, contextDir: string, dockerfile: string) => Promise<void>
  readCapacity: Parameters<typeof assertHostCapacity>[1]
  sweepFn: (opts: { activeRunId: string; onWarning: (m: string) => void }) => Promise<string[]>
  validateModels: (client: OpenCodeClient, directory: string, config: RunConfig) => Promise<void>
}

export const defaultSeams: ComposeSeams = {
  startHostServer: (opts) => startServer({ timeoutMs: opts.timeoutMs }),
  attachHostServer: (url, timeoutMs) => attachServer(url, timeoutMs),
  ensureImageFn: (image, contextDir, dockerfile) => ensureImage(image, contextDir, dockerfile),
  readCapacity: undefined as never,
  sweepFn: undefined as never,
  validateModels: undefined as never,
}

export interface ComposedRun {
  config: RunConfig
  sandbox: Sandbox
  provider: Provider
  runner: AgentRunner
  planFor: ((agentIds: readonly string[]) => Promise<void>) | null
  serverHandle: ServerHandle | null
  shardServers: { baseUrl: string; directory: string }[]
  sessionMap: Map<string, string>
  sessionHook: (agentId: string, sessionId: string) => void
  warnings: string[]
  capacity: { committed: number; maxContainers: number } | null
  cleanup: () => Promise<void>
}

function runConfigFor(spec: RunSpec): RunConfig {
  return {
    ...DEFAULT_CONFIG,
    populationSize: spec.population,
    sandbox: spec.sandbox,
    roster: spec.roster,
    judge: { ...DEFAULT_CONFIG.judge, modelId: spec.judge.modelId, mode: spec.judge.mode },
    reflect: { ...DEFAULT_CONFIG.reflect, modelId: spec.reflect.modelId, topK: spec.reflect.topK },
    budget: { ...DEFAULT_CONFIG.budget, ...spec.budget },
    seedDir: spec.seedDir,
  }
}

/**
 * Shared mock/local/docker composition for one run. The server calls this per
 * run-spec; the CLI delegates its private builder to it (Task 2, Step 4), so
 * both paths validate, cap, and warn identically. Seams keep every test
 * daemon-free: pass fakes, never a real Docker host or provider account.
 */
export async function composeRun(spec: RunSpec, seams: Partial<ComposeSeams> = {}): Promise<ComposedRun> {
  const s: ComposeSeams = { ...defaultSeams, ...seams }
  const config = runConfigFor(spec)
  const warnings: string[] = []
  const onWarning = (m: string) => warnings.push(m)
  const sessionMap = new Map<string, string>()
  const sessionHook = (agentId: string, sessionId: string) => {
    sessionMap.set(sessionId, agentId)
  }

  if (spec.sandbox === 'mock') {
    const sandbox = new MockSandbox()
    return {
      config, sandbox,
      provider: new MockProvider(42),
      runner: new MockAgentRunner(sandbox, 42),
      planFor: null,
      serverHandle: null,
      shardServers: [],
      sessionMap, sessionHook, warnings,
      capacity: null,
      cleanup: async () => {},
    }
  }

  const workspaceRoot = spec.workspaceRoot!
  if (spec.sandbox === 'docker') {
    await assertHostCapacity(config, s.readCapacity as never, onWarning)
  }
  const server = spec.serverUrl
    ? await s.attachHostServer(spec.serverUrl, config.agentTimeoutMs)
    : await s.startHostServer({ timeoutMs: config.agentTimeoutMs })
  const provider = new OpenCodeProvider(server.client, workspaceRoot, {
    timeoutMs: config.agentTimeoutMs,
  })
  try {
    const validate = s.validateModels ?? (async () => {})
    await validate(server.client, workspaceRoot, config)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/judge|reflect/i.test(message)) {
      await server.stop().catch(() => {})
      throw e
    }
    onWarning(message)
  }

  if (spec.sandbox === 'docker') {
    await sweepBeforeRun(config, `pending-${Date.now()}`, {
      readCapacity: s.readCapacity as never,
      sweep: s.sweepFn as never,
    }, onWarning).catch(() => [])
    await s.ensureImageFn(AGENT_IMAGE, process.cwd(), 'docker/Dockerfile.agent')
    const shardServers: { baseUrl: string; directory: string }[] = []
    const sandbox = new DockerSandbox({
      runId: `pending-${Date.now()}`,
      root: workspaceRoot,
      maxContainers: config.maxContainers,
      image: AGENT_IMAGE,
      memory: config.containerMemory,
      cpus: config.containerCpus,
      authFile: spec.authFile,
      startContainer: async (shardIndex, hostDir) => {
        const started = await startShardContainer(
          {
            runId: `pending-${Date.now()}`,
            shardIndex,
            image: AGENT_IMAGE,
            hostDir,
            memory: config.containerMemory,
            cpus: config.containerCpus,
            authFile: spec.authFile,
          },
          undefined,
          async (baseUrl) => new OpenCodeClient({ baseUrl, timeoutMs: 10_000 }).health(),
          onWarning,
        )
        shardServers.push({ baseUrl: started.baseUrl, directory: hostDir })
        return started
      },
      stopContainer: async (name) => {
        await removeContainer(name, onWarning)
      },
      onWarning,
    })
    const runner = new OpenCodeAgentRunner(
      makeClientResolver(sandbox, server.client, (baseUrl) =>
        new OpenCodeClient({ baseUrl, timeoutMs: config.agentTimeoutMs })),
      sandbox,
      { onSessionCreated: sessionHook },
    )
    return {
      config, sandbox, provider, runner,
      planFor: (agentIds) => sandbox.planFor(agentIds),
      serverHandle: server, shardServers,
      sessionMap, sessionHook, warnings,
      capacity: { committed: Math.min(config.maxContainers, spec.population), maxContainers: config.maxContainers },
      cleanup: async () => {
        await (sandbox as DockerSandbox).disposeAll?.().catch(() => {}) as never
        await server.stop().catch(() => {})
      },
    }
  }

  const sandbox = new LocalSandbox(workspaceRoot)
  return {
    config, sandbox, provider,
    runner: new OpenCodeAgentRunner(server.client, sandbox, { onSessionCreated: sessionHook }),
    planFor: null,
    serverHandle: server,
    shardServers: [{ baseUrl: '', directory: workspaceRoot }],
    sessionMap, sessionHook, warnings,
    capacity: null,
    cleanup: async () => {
      await server.stop().catch(() => {})
    },
  }
}
```

The third test above passes a no-op validate to assert the seam contract; the
fatal-vs-warn split is covered by asserting `validateRosterModels` semantics
through the `onWarning` path in the CLI suite (unchanged) plus Task 7's matrix.

- [ ] **Step 4: Delegate the CLI builder to the shared module**

In `src/cli.ts`, keep `buildRealDeps`' signature and replace its body with a
call into `composeRun` (mapping `CliOptions` to `RunSpec` via `parseRunSpec`
plus `resolveSandboxMode`), preserving `RunIdHolder` behavior. Run the
existing CLI-adjacent suites to prove no behavior change:

Run: `npx vitest run test/runtime/docker test/runtime/opencode && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run test/server/compose-run.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/server/compose-run.ts test/server/compose-run.test.ts src/cli.ts
git commit -m "feat: share mock-local-docker composition between CLI and server"
```

---

## Task 3: Per-run registry and spec-driven creation

**Files:**
- Create: `src/server/runs.ts`
- Modify: `src/server/api.ts`
- Test: `test/server/api.test.ts` (extend; existing setup keeps passing unchanged)

**Interfaces:**
- Consumes: `ComposedRun`, `composeRun` from `./compose-run.js`; `parseRunSpec` from `./run-spec.js`; `RunManager` from `./run-manager.js`; `TournamentEngine` wiring (same constructor args as `src/server/index.ts` today); `BridgeHandle` from `./event-bridge.js`.
- Produces: `RunRegistry` (`get`, `set`, `has`, `records`), `RunRecord` (`{ runId, engine, manager, composed, bridges, warnings, capacity }`) used by Tasks 4 and 5; `buildApi` keeps its current `createRun` signature working (new `composeRun` dep is optional) so the existing 7 API tests pass untouched.

- [ ] **Step 1: Add the failing tests** (append to `test/server/api.test.ts`)

```typescript
test('POST /api/runs accepts a local spec', async () => {
  const { app } = setup()
  const res = await app.inject({
    method: 'POST', url: '/api/runs',
    payload: {
      name: 'real', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
      roster: [{ modelId: 'w/m', count: 2, temperature: 0.7 }],
    },
  })
  expect([201, 400]).toContain(res.statusCode)
})

test('POST /api/runs rejects docker without authFile', async () => {
  const { app } = setup()
  const res = await app.inject({
    method: 'POST', url: '/api/runs',
    payload: {
      name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w',
      roster: [{ modelId: 'w/m', count: 2, temperature: 0.7 }],
    },
  })
  expect(res.statusCode).toBe(400)
})

test('POST /api/runs keeps the legacy name+goal shape', async () => {
  const { app } = setup()
  const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })
  expect(res.statusCode).toBe(201)
})
```

The local-spec case allows 400 here because the default setup has no compose
seam; Task 5's wiring test asserts the 201 path with fakes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/api.test.ts`
Expected: FAIL — docker-without-auth returns 201 (no validation yet).

- [ ] **Step 3: Create `src/server/runs.ts`**

```typescript
import type { TournamentEngine } from '../engine/driver.js'
import type { BridgeHandle } from './event-bridge.js'
import type { RunManager } from './run-manager.js'
import type { ComposedRun } from './compose-run.js'
import type { RunSpec } from './run-spec.js'

export interface RunRecord {
  runId: string
  spec: RunSpec
  engine: TournamentEngine
  manager: RunManager
  composed: ComposedRun
  bridges: BridgeHandle[]
  warnings: string[]
  capacity: { committed: number; maxContainers: number } | null
}

export class RunRegistry {
  private records = new Map<string, RunRecord>()

  set(record: RunRecord): void {
    this.records.set(record.runId, record)
  }

  get(runId: string): RunRecord | null {
    return this.records.get(runId) ?? null
  }

  has(runId: string): boolean {
    return this.records.has(runId)
  }

  get size(): number {
    return this.records.size
  }
}
```

- [ ] **Step 4: Modify `src/server/api.ts`** (additive only)

Add optional `composeRun` and `registry` to `ApiDeps`; in `POST /api/runs`,
when the body carries `sandbox`/`roster`, parse via `parseRunSpec` (400 with
the error message on throw); otherwise keep the legacy `createRun` path so
the existing 7 tests pass unchanged. On the spec path without a compose seam
injected (unit tests), return 400 `{ error: 'real modes unavailable' }`
rather than touching a daemon — Task 5 injects fakes and asserts 201.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/server/api.test.ts && npm run typecheck`
Expected: PASS (10 tests: 7 legacy + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/server/runs.ts src/server/api.ts test/server/api.test.ts
git commit -m "feat: validate full run specs on creation"
```

---

## Task 4: Config patching and snapshot gains

**Files:**
- Modify: `src/server/api.ts` (PATCH route), `src/server/state.ts` (snapshot gains), `src/db/repos.ts` (`runs.updateConfig`), `web/src/api.ts` (patchConfig client)
- Test: `test/server/api.test.ts` (PATCH guards), `test/server/state.test.ts` (snapshot gains), `test/db/repos.test.ts` (updateConfig)

**Interfaces:**
- Consumes: `RunRegistry` from `./runs.js`; `RunManager.isBusy` for the 409 guard; `buildRunSnapshot` extended return.
- Produces: `PATCH /api/runs/:id/config` semantics (409 busy, 400 invalid, 200 with warnings) and `RunSnapshot` gains `{ sandbox, roster, capacity, warnings }` consumed by Task 6.

- [ ] **Step 1: Add the failing tests**

```typescript
// test/server/api.test.ts (append)
test('PATCH /api/runs/:id/config rejects unknown runs', async () => {
  const { app } = setup()
  const res = await app.inject({ method: 'PATCH', url: '/api/runs/nope/config', payload: { budget: { maxAgentTokens: 10 } } })
  expect(res.statusCode).toBe(404)
})

// test/server/state.test.ts (append)
test('snapshot carries sandbox and roster from run config', () => {
  const { repos, run } = setup()
  const s = buildRunSnapshot(repos, run.id, { sandbox: 'mock', roster: [], warnings: [], capacity: null } as never)!
  expect(s.sandbox).toBe('mock')
  expect(s.warnings).toEqual([])
})
```

`setup` in `state.test.ts` is the existing helper from Task 4a Task 4; reuse it unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/api.test.ts test/server/state.test.ts`
Expected: FAIL — PATCH route missing (404 body mismatch), snapshot gains missing.

- [ ] **Step 3: Implement**

`src/db/repos.ts`: add `updateConfig(runId: string, config: RunConfig): void`
next to `runs.create`/`get`, mirroring existing style:

```typescript
updateConfig(runId: string, config: RunConfig): void {
  db.prepare('UPDATE runs SET config_json = ? WHERE id = ?').run(encodeConfig(config), runId)
},
```

`src/server/state.ts`: extend `RunSnapshot` with
`sandbox: string; roster: { modelId: string; count: number; temperature: number }[]; capacity: { committed: number; maxContainers: number } | null; warnings: string[];`
and take an optional third arg `extra?: { sandbox?: string; roster?: RunSnapshotExtra['roster']; capacity?: ...; warnings?: string[] }` defaulting sandbox to the stored config's sandbox (parsed from `run.config`), roster to its roster, capacity/warnings to null/[]. Keep the two-arg call working so existing tests pass.

`src/server/api.ts`: add
`app.patch('/api/runs/:id/config', ...)` — 404 unknown run; 409 when
`manager.isBusy(id)`; parse `{ roster?, budget?, judge? }` (400 on Zod throw
or population mismatch); apply via `repos.runs.updateConfig` plus update the
registry record's spec; return `{ warnings }`.

`web/src/api.ts`: add

```typescript
export const patchConfig = (runId: string, config: unknown): Promise<{ warnings: string[] }> =>
  fetch(`/api/runs/${runId}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  }).then(json)
```

and extend the client `RunSnapshot` with the four new fields (nullable-safe:
`sandbox: string; roster: SnapshotAgent[] extends? no — roster: { modelId: string; count: number; temperature: number }[]; capacity: { committed: number; maxContainers: number } | null; warnings: string[]`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/api.test.ts test/server/state.test.ts test/db/repos.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/api.ts src/server/state.ts src/db/repos.ts web/src/api.ts test/server/api.test.ts test/server/state.test.ts test/db/repos.test.ts
git commit -m "feat: patch run config between rounds and surface it in snapshots"
```

---

## Task 5: Per-run server root with bridge lifecycle

**Files:**
- Modify: `src/server/index.ts`
- Test: `test/server/real-modes.test.ts` (new; fakes only, no daemon)

**Interfaces:**
- Consumes: `composeRun` + `defaultSeams` from `./compose-run.js`; `RunRegistry` from `./runs.js`; `buildApi` (extended deps from Task 3); `RunManager`, `EventBroadcaster`, `startEventBridge`, engine pieces (same constructor args as today).
- Produces: per-run `RunRecord` with bridges started per endpoint and stopped on dispose; `--workspace-root`, `--auth-file`, `--server-url` flags; the mock default path byte-identical to today when no flags are given.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test, vi } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildApi } from '../../src/server/api.js'
import { RunRegistry } from '../../src/server/runs.js'

describe('real-mode wiring', () => {
  test('a composed local run registers bridges and disposes them', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const stop = vi.fn()
    registry.set({
      runId: 'r1', spec: { sandbox: 'local' } as never,
      engine: {} as never, manager: { disposeAll: vi.fn() } as never,
      composed: { cleanup: vi.fn(async () => {}) } as never,
      bridges: [{ stop }],
      warnings: [], capacity: null,
    })
    expect(registry.get('r1')!.bridges).toHaveLength(1)
    for (const b of registry.get('r1')!.bridges) b.stop()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('POST /api/runs with fakes creates a bridged run', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('must not be called for specs') }) as never,
      registry: new RunRegistry(),
      composeWith: (async () => ({
        config: {}, sandbox: {}, provider: {}, runner: {},
        planFor: null, serverHandle: null, shardServers: [],
        sessionMap: new Map(), sessionHook: () => {}, warnings: [],
        capacity: null, cleanup: async () => {},
      })) as never,
    } as never)
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'l', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      },
    })
    expect(res.statusCode).toBe(201)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/real-modes.test.ts`
Expected: FAIL — `registry`/`composeWith` unknown to `buildApi`.

- [ ] **Step 3: Implement**

Extend `ApiDeps` with optional `registry?: RunRegistry` and
`composeWith?: (spec: RunSpec) => Promise<ComposedRun>`. On the spec path
with a seam present: compose, create the engine exactly as
`src/server/index.ts` does today (MockProvider/MockSandbox/MockAgentRunner/
Judge/Reflector with `seedStrategy` and `onEvent: emit`), create the run row
with the composed config, wrap it in a per-run `RunManager`, store the
`RunRecord`, and start one bridge per endpoint —
local: `startEventBridge({ baseUrl: serverUrl-or-host, directory: workspaceRoot, runId, lookupAgent: (sid) => sessionMap.get(sid) ?? null, emit })`;
docker: one bridge per `shardServers` entry (directory per shard);
mock: no bridges. Push each handle into `record.bridges`. Shutdown stops
bridges, then `composed.cleanup()`, then `manager.disposeAll()`.

Rewrite `src/server/index.ts` to build a registry, pass a real `composeWith`
(using `defaultSeams` plus CLI flag values), add `--workspace-root`,
`--auth-file`, `--server-url` flags, and keep the no-flags path byte-identical
to today's mock wiring.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/server/api.ts src/server/runs.ts test/server/real-modes.test.ts
git commit -m "feat: compose real-mode runs per spec with bridge lifecycle"
```

---

## Task 6: Run-setup screen

**Files:**
- Create: `web/src/components/RunSetup.tsx`
- Modify: `web/src/App.tsx`, `web/src/styles.css`
- Test: headless gate is `npm run typecheck` plus `npm run web:build` (repo precedent: components ship without browser tests; reducer logic stays covered by `test/web/live-run.test.ts`).

**Interfaces:**
- Consumes: `createRun`, `patchConfig`, `RunSnapshot` from `../api.js`; snapshot gains from Task 4.
- Produces: setup-first UX — no auto-created run; the arena renders after setup succeeds.

- [ ] **Step 1: Create `web/src/components/RunSetup.tsx`**

```tsx
import { useState } from 'react'

export interface RunSetupValue {
  name: string
  goal: string
  sandbox: 'mock' | 'local' | 'docker'
  rosterText: string
  workspaceRoot: string
  authFile: string
}

export function RunSetup({ busy, error, onCreate }: {
  busy: boolean
  error: string | null
  onCreate: (value: RunSetupValue) => void
}) {
  const [name, setName] = useState('arena')
  const [goal, setGoal] = useState('Produce the best possible answer.')
  const [sandbox, setSandbox] = useState<RunSetupValue['sandbox']>('mock')
  const [rosterText, setRosterText] = useState('mock/model x4 @0.7')
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [authFile, setAuthFile] = useState('')

  const needsPaths = sandbox !== 'mock'

  return (
    <div className="setup">
      <label htmlFor="setup-name">Run name</label>
      <input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      <label htmlFor="setup-goal">Goal</label>
      <textarea id="setup-goal" value={goal} rows={3} onChange={(e) => setGoal(e.target.value)} disabled={busy} />
      <label htmlFor="setup-sandbox">Sandbox</label>
      <select
        id="setup-sandbox"
        value={sandbox}
        onChange={(e) => setSandbox(e.target.value as RunSetupValue['sandbox'])}
        disabled={busy}
      >
        <option value="mock">mock (free, no isolation)</option>
        <option value="local">local (real agents on this host)</option>
        <option value="docker">docker (isolated containers)</option>
      </select>
      <label htmlFor="setup-roster">Roster (one `model xN @temp` per line)</label>
      <textarea id="setup-roster" value={rosterText} rows={4} onChange={(e) => setRosterText(e.target.value)} disabled={busy} />
      {needsPaths && (
        <>
          <label htmlFor="setup-root">Workspace root</label>
          <input id="setup-root" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} disabled={busy} />
        </>
      )}
      {sandbox === 'docker' && (
        <>
          <label htmlFor="setup-auth">Auth file (bind-mounted read-only)</label>
          <input id="setup-auth" value={authFile} onChange={(e) => setAuthFile(e.target.value)} disabled={busy} />
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button
        disabled={busy || name.trim().length === 0 || goal.trim().length === 0}
        onClick={() => onCreate({ name, goal, sandbox, rosterText, workspaceRoot, authFile })}
      >
        {busy ? 'Creating…' : 'Create run'}
      </button>
    </div>
  )
}
```

Roster lines parse as `modelId x<count> @<temperature>`; a line that does not
parse is a client-side error naming the line number (no request sent).

- [ ] **Step 2: Modify `web/src/App.tsx`** (setup-first, no auto-create)

Replace the mount effect that auto-creates the `dashboard` run: start with
`snapshot === null` rendering `<RunSetup>`; on create, parse roster lines,
POST the full spec via a new `createRunFull` client (added to `web/src/api.ts`
next to `createRun`, which stays for tests), show server `warnings` and
400/409 messages inline, and only then render the arena. Keep the
post-round refresh effect and all Task 12 components unchanged.

- [ ] **Step 3: Modify `web/src/api.ts`** — add

```typescript
export interface FullRunSpec {
  name: string
  goal: string
  sandbox: 'mock' | 'local' | 'docker'
  roster: { modelId: string; count: number; temperature: number }[]
  workspaceRoot: string | null
  authFile: string | null
}

export const createRunFull = (spec: FullRunSpec): Promise<{ runId: string; warnings?: string[] }> =>
  fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  }).then(json)
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run web:build`
Expected: both exit 0; build transforms without errors.

- [ ] **Step 5: Commit**

```bash
git add web/
git commit -m "feat: add the run-setup screen with sandbox and roster"
```

---

## Task 7: Matrix tests, e2e guards, full gate

**Files:**
- Create: `test/server/run-matrix.test.ts`
- Test: `test/server/dashboard.e2e.test.ts` (extend with guard cases, file otherwise unchanged)

**Interfaces:**
- Consumes: every Task 1–6 seam. Produces: the release gate.

- [ ] **Step 1: Write the matrix test**

```typescript
import { describe, expect, test } from 'vitest'
import { composeRun } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

const seams = {
  startHostServer: (async () => ({ client: { id: 'h' }, stop: async () => {} })) as never,
  attachHostServer: (async () => { throw new Error('no server here') }) as never,
  ensureImageFn: (async () => {}) as never,
  readCapacity: (async () => ({ memoryBytes: 32 * 1024 ** 3, cpuCount: 8 })) as never,
  sweepFn: (async () => []) as never,
  validateModels: (async () => {}) as never,
}

describe('run matrix', () => {
  test('mock composes without touching any seam', async () => {
    let touched = false
    const c = await composeRun(parseRunSpec({
      name: 'm', goal: 'g', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
    }), { ...seams, startHostServer: (async () => { touched = true; throw new Error('x') }) as never })
    expect(touched).toBe(false)
    expect(c.serverHandle).toBeNull()
  })

  test('local composes against the fake host server', async () => {
    const c = await composeRun(parseRunSpec({
      name: 'l', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
      roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
    }), seams)
    expect(c.serverHandle).toBeTruthy()
    expect(c.planFor).toBeNull()
    await c.cleanup()
  })

  test('docker refusal names the shortage', async () => {
    await expect(composeRun(parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w', authFile: '/tmp/a',
      roster: [{ modelId: 'w/m', count: 32, temperature: 0.7 }],
    }), { ...seams, readCapacity: (async () => ({ memoryBytes: 512 * 1024 ** 2, cpuCount: 1 })) as never })
    ).rejects.toThrow(/docker sandbox/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/server/run-matrix.test.ts`
Expected: FAIL — Task 2/3 seams shape drift (or missing module if those tasks regressed).

- [ ] **Step 3: Extend the e2e with guard cases** (append two tests, keep the 4a test intact)

```typescript
test('guards hold: unknown targets 404 and missing goal 400s', async () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const population = 2
  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    populationSize: population,
    sandbox: 'mock',
    roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
  }
  const broadcaster = new EventBroadcaster()
  const emit = (e: EngineEvent) => broadcaster.broadcast(e)
  const provider = new MockProvider(42)
  const sandbox = new MockSandbox()
  const engine = new TournamentEngine({
    repos, config, sandbox,
    runner: new MockAgentRunner(sandbox, 42),
    judge: new Judge(provider, config.judge, 42),
    reflector: new Reflector(provider, config.reflect, ['mock/model']),
    seedStrategy: (i) => `attempt the goal, variant ${i}`,
    onEvent: emit,
  })
  const manager = new RunManager(engine, emit)
  const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

  const nopeRound = await app.inject({ method: 'POST', url: '/api/runs/nope/rounds', payload: { goalMd: 'g' } })
  expect(nopeRound.statusCode).toBe(404)

  const created = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' } })).body,
  )
  const noGoal = await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/rounds`, payload: {} })
  expect(noGoal.statusCode).toBe(400)

  const nopePatch = await app.inject({
    method: 'PATCH', url: '/api/runs/nope/config', payload: { budget: { maxAgentTokens: 10 } },
  })
  expect(nopePatch.statusCode).toBe(404)

  await app.close()
}, 60_000)

test('PATCH on a busy run returns 409', async () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const app = buildApi({
    repos,
    manager: { isBusy: () => true, lastError: () => null, startRound: () => {} } as never,
    createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
  })
  const created = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' } })).body,
  )
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${created.runId}/config`, payload: { budget: { maxAgentTokens: 10 } },
  })
  expect(res.statusCode).toBe(409)
  await app.close()
})
```

The 409 case uses a stubbed busy manager on purpose: asserting against a live
round would race the mock engine finishing before the PATCH arrives.

- [ ] **Step 4: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: all green (49+ files pass, 2 pre-existing e2e skips).

Dashboard smoke (manual, then stop with Ctrl-C):
Terminal 1: `npm run dashboard -- --port 4300`
Terminal 2: `curl -s http://127.0.0.1:4300/api/runs` → `{"runs":[]}`.

- [ ] **Step 5: Commit**

```bash
git add test/server/run-matrix.test.ts test/server/dashboard.e2e.test.ts
git commit -m "test: cover the run matrix and guard rails end to end"
```

---

## Self-review

**Spec coverage.** Design §1 (shared composition, per-run engines, shared broadcaster, bridge per endpoint with `?directory=`) → Tasks 2, 3, 5. §2 (POST spec + Zod rules, PATCH next-round semantics + 409/400, snapshot gains, setup screen) → Tasks 1, 3, 4, 6. §3 (lifecycle, error taxonomy, test gates) → Tasks 5, 7. Deferred analytics (4c) untouched.

**Type consistency.** `RunSpec` (Task 1) flows into `composeRun` (Task 2), `RunRecord` (Task 3), PATCH merge (Task 4), `FullRunSpec` client (Task 6, same field names). `capacity { committed, maxContainers } | null` and `warnings: string[]` spelled identically in registry, snapshot, and client. `BridgeHandle.stop` (4a) is the only bridge API used. `ServerHandle.stop` (not close) is the only server cleanup used.

**No placeholders.** Every task ships exact test code, exact implementation, exact commands, and exact commit messages. Seams keep daemon/creds tests hermetic; the two manual smokes name exact commands and expected output.
