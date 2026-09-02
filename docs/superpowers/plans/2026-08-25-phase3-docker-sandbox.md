# Agent Tournament — Phase 3: Docker Sandbox

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run tournament agents inside resource-capped Docker containers so agent-authored code cannot touch the host, cannot degrade the machine, and cannot destroy another agent's work — with a sharded layout for populations larger than memory allows.

**Architecture:** Agents are distributed across a configurable number of containers, each running an `opencode serve` bound to a per-shard workspace directory. The orchestrator talks to each shard's container over its published port. Everything drops in behind the existing `Sandbox` interface, so the engine, selection, judging and breeding code is untouched.

**Tech Stack:** TypeScript 5, Node 24, Docker CLI via `node:child_process`, Vitest.

**Sources:** `docs/superpowers/specs/2026-08-22-agent-tournament-design.md` (§11 sandbox layer), `docs/superpowers/specs/2026-08-24-opencode-api-spike.md`, `docs/superpowers/plans/phase2-prerequisites.md`.

---

## Verified facts — measured on this machine, 2026-08-25

Every number below came from building the image and running real containers. Do not re-derive
them; do not assume different ones.

**A containerized agent works end to end.** A container running `opencode serve` with
`auth.json` bind-mounted read-only saw all 36 models, ran a real agent against
`wandb/deepseek-ai/DeepSeek-V4-Flash`, and wrote `SUBMISSION.md` which appeared on the host
through the bind mount. 6.8s, $0.00056.

**Memory is the binding constraint.**

| Measurement | Value |
|---|---|
| Image size on disk | 960 MB |
| Container memory, idle | ~250 MiB |
| Container memory, **under real work** | **~413 MiB** |
| Marginal cost per extra container | ~250 MiB — no meaningful page sharing |
| Docker allocation on this host | 6.69 GiB |
| Consumed by the user's other containers | ~1.5 GiB |
| **Free headroom** | **~5.2 GiB** |

All agents run concurrently during RUN, so the loaded figure binds. **Per-agent containers top
out around 8–12 on this host** — far below the 20-agent default and nowhere near 100. Sharding
is therefore mandatory, not an optimization.

**Host isolation holds.** An agent asked to `ls /work/..` saw the *container's* root
(`bin boot dev etc ... work`), not the host filesystem.

**Port allocation works.** `-p 127.0.0.1:0:4096` publishes an ephemeral host port, readable via
`docker port <name> 4096/tcp` → `4096/tcp -> 127.0.0.1:32769`.

**git is required in the image.** OpenCode initialises a repo in the working directory for its
snapshot and diff features.

## The isolation trade-off, stated plainly

Sharding gives **full host isolation** — no agent can reach the user's machine. Within a shard it
does **not** give agent-vs-agent isolation: agents sharing a container can read and write each
other's workspaces.

**Why prevention is not achievable inside a shard.** Every agent in a container is executed by the
*same* `opencode serve` process, as the same OS user. Per-directory permissions or per-agent Linux
users therefore cannot separate them — there is only one uid doing the work. The `?directory=`
parameter sets a working directory; it does not confine tools. This was measured: an agent asked to
`ls /work/..` saw the whole container root. Anyone claiming per-agent isolation inside a shared
container is mistaken.

That matters more here than in an ordinary system. Agents are selected on rank and mutate toward
whatever wins, so deleting a competitor's `SUBMISSION.md` is a *reachable winning strategy* — the
same adversarial-by-selection logic that made the judge-prompt injection channel worth closing in
Phase 1.

**So the design does three things:**

1. **Defaults to full isolation.** `maxContainers` defaults to the population size, so every agent
   gets its own container and prevention is real. Sharding is an explicit opt-in, taken only when
   the population exceeds what memory allows, and the CLI states the trade-off when it happens.
2. **Captures output the moment an agent finishes** (Task 12), so a later saboteur cannot destroy
   work that has already been recorded. This shrinks the vulnerable window from "the whole round" to
   "while that agent is still running."
3. **Detects tampering** (Task 12) by hashing each agent's submission at capture and re-checking at
   collect, so sabotage inside a shard is surfaced and attributed rather than silently rewarding the
   saboteur.

Prevention where affordable, containment and detection where it is not — and never a claim of
prevention that the architecture cannot deliver.

## Layout

```
<workspaceRoot>/
  shard-0/            <- bind-mounted to /work in container arena-<runId>-0
    <agentId-a>/      <- agent sees /work/<agentId-a>
    <agentId-b>/
  shard-1/            <- bind-mounted to /work in container arena-<runId>-1
    <agentId-c>/
```

Mounting a **per-shard** root rather than the whole workspace root is deliberate: it keeps agents in
one shard from seeing agents in another.

## Host path vs container path — the thing most likely to break

`AgentHandle.workspacePath` is passed to `client.createSession(...)` and becomes the OpenCode
`?directory=` parameter, so it must be the **container** path (`/work/<agentId>`). File operations
performed by the orchestrator (`writeFile`, `readFile`, `listFiles`) happen on the **host** path
(`<workspaceRoot>/shard-<k>/<agentId>`). `DockerSandbox` holds both and never confuses them.

`Sandbox` gains `endpoint(handle)` returning the shard's `baseUrl`, restoring the method the design
spec specified and Phase 2 dropped. It is required now because each shard has a different port.

## File structure

| Path | Responsibility |
|---|---|
| `docker/Dockerfile.agent` | The agent image. Verified working. |
| `src/runtime/docker/cli.ts` | Thin async wrapper over the Docker CLI, every call timeout-bounded. |
| `src/runtime/docker/image.ts` | Ensure the agent image exists, building it when absent. |
| `src/runtime/docker/shard.ts` | Pure: distribute agents across shards. |
| `src/runtime/docker/container.ts` | Container lifecycle: start, wait healthy, port discovery, stop, reconcile. |
| `src/runtime/docker/sandbox.ts` | `DockerSandbox implements Sandbox`. |

Modified: `src/runtime/sandbox.ts` (add `endpoint`), `src/runtime/mock-sandbox.ts`,
`src/runtime/local-sandbox.ts`, `src/runtime/opencode/agent-runner.ts` (per-shard client),
`src/engine/driver.ts` (teardown + PREPARE isolation), `src/cli.ts`, `src/core/types.ts`.

---

## Task 1: The agent Dockerfile

**Files:**
- Create: `docker/Dockerfile.agent`
- Test: `test/runtime/docker/dockerfile.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = () => readFile(join(process.cwd(), 'docker/Dockerfile.agent'), 'utf8')

describe('Dockerfile.agent', () => {
  test('pins the opencode version rather than floating on latest', async () => {
    const df = await read()
    expect(df).toMatch(/opencode-ai@\d+\.\d+\.\d+/)
  })

  test('installs git, which opencode requires for snapshots', async () => {
    expect(await read()).toMatch(/apt-get install[^\n]*git/)
  })

  test('binds the server to 0.0.0.0 so the published port is reachable', async () => {
    expect(await read()).toContain('0.0.0.0')
  })

  test('uses /work as the working directory', async () => {
    expect(await read()).toMatch(/WORKDIR \/work/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/docker/dockerfile.test.ts`
Expected: FAIL — the file does not exist.

- [ ] **Step 3: Create `docker/Dockerfile.agent`**

```dockerfile
# Agent arena container: runs an opencode server for one shard of tournament agents.
#
# Verified 2026-08-25: 960MB image, ~250MiB idle, ~413MiB under real work.
FROM node:24-slim

# git is required: opencode initialises a repo in the working directory for its
# snapshot/diff features and fails noisily without it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@1.18.21 \
    && npm cache clean --force

WORKDIR /work

# 0.0.0.0 so the published port is reachable from the host.
EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/docker/dockerfile.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile.agent test/runtime/docker/dockerfile.test.ts
git commit -m "feat: add the agent container image"
```

---

## Task 2: Docker CLI wrapper

Every call is timeout-bounded. A hung `docker` invocation must never hang a round.

**Files:**
- Create: `src/runtime/docker/cli.ts`
- Test: `test/runtime/docker/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { parsePortMapping, buildRunArgs } from '../../../src/runtime/docker/cli.js'

describe('parsePortMapping', () => {
  test('extracts the host port from docker port output', () => {
    expect(parsePortMapping('4096/tcp -> 127.0.0.1:32769')).toBe(32769)
  })

  test('handles 0.0.0.0 bindings', () => {
    expect(parsePortMapping('4096/tcp -> 0.0.0.0:41000')).toBe(41000)
  })

  test('takes the first mapping when several are printed', () => {
    expect(parsePortMapping('4096/tcp -> 127.0.0.1:32769\n4096/tcp -> [::1]:32770')).toBe(32769)
  })

  test('returns null when there is no mapping', () => {
    expect(parsePortMapping('')).toBeNull()
  })
})

describe('buildRunArgs', () => {
  const base = {
    name: 'arena-run1-0',
    image: 'agent-arena:latest',
    hostDir: '/host/shard-0',
    memory: '1g',
    cpus: 1,
    authFile: '/host/auth.json',
    pidsLimit: 256,
    maxFileBytes: 268_435_456,
  }

  test('publishes an ephemeral port bound to loopback only', () => {
    expect(buildRunArgs(base).join(' ')).toContain('-p 127.0.0.1:0:4096')
  })

  test('applies memory and cpu limits', () => {
    const a = buildRunArgs(base).join(' ')
    expect(a).toContain('-m 1g')
    expect(a).toContain('--cpus 1')
  })

  test('pins swap to the memory limit so a leak cannot thrash the host disk', () => {
    expect(buildRunArgs(base).join(' ')).toContain('--memory-swap 1g')
  })

  test('caps process count to stop a fork bomb taking the machine down', () => {
    expect(buildRunArgs(base).join(' ')).toContain('--pids-limit 256')
  })

  test('caps single-file size so an agent cannot fill the disk', () => {
    expect(buildRunArgs(base).join(' ')).toContain('--ulimit fsize=268435456')
  })

  test('caps open file descriptors', () => {
    expect(buildRunArgs(base).join(' ')).toMatch(/--ulimit nofile=\d+/)
  })

  test('never grants GPU access', () => {
    expect(buildRunArgs(base).join(' ')).not.toContain('--gpus')
  })

  test('drops all Linux capabilities and blocks privilege escalation', () => {
    const a = buildRunArgs(base).join(' ')
    expect(a).toContain('--cap-drop ALL')
    expect(a).toContain('--security-opt no-new-privileges')
  })

  test('mounts the workspace read-write and auth read-only', () => {
    const a = buildRunArgs(base).join(' ')
    expect(a).toContain('/host/shard-0:/work')
    expect(a).toContain('/host/auth.json:/root/.local/share/opencode/auth.json:ro')
  })

  test('omits the auth mount when no auth file is configured', () => {
    expect(buildRunArgs({ ...base, authFile: null }).join(' ')).not.toContain('auth.json')
  })

  test('names the container', () => {
    expect(buildRunArgs(base).join(' ')).toContain('--name arena-run1-0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/docker/cli.test.ts`
Expected: FAIL — cannot resolve `cli.js`.

- [ ] **Step 3: Implement**

```typescript
import { execFile } from 'node:child_process'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/** Runs `docker` with a hard timeout. A hung CLI call must never hang a round. */
export function docker(args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
      })
    })
  })
}

/** `docker port` prints e.g. `4096/tcp -> 127.0.0.1:32769`. */
export function parsePortMapping(out: string): number | null {
  for (const line of out.split('\n')) {
    const m = /->\s*(?:\[[^\]]+\]|[^:]+):(\d+)\s*$/.exec(line.trim())
    if (m) return Number(m[1])
  }
  return null
}

export interface RunSpec {
  name: string
  image: string
  hostDir: string
  memory: string
  cpus: number
  authFile: string | null
  pidsLimit?: number
  maxFileBytes?: number
  maxOpenFiles?: number
}

/**
 * Every limit here exists to stop agent-authored code degrading the host.
 *
 * Agents run arbitrary shell commands and are selected on outcome, so a strategy that
 * happens to spawn processes, allocate memory or write huge files is something the
 * tournament can actively evolve toward. These caps are the backstop.
 *
 * Note what is absent: `--gpus` is never passed, so containers get no GPU access at all.
 */
export function buildRunArgs(spec: RunSpec): string[] {
  const pids = spec.pidsLimit ?? 256
  const fsize = spec.maxFileBytes ?? 268_435_456 // 256MB per file
  const nofile = spec.maxOpenFiles ?? 2048

  return [
    'run', '-d',
    '--name', spec.name,

    // Memory: --memory-swap equal to --memory disables swap for the container.
    // Without this a leaking agent swaps instead of being killed, which drags the
    // whole host to a crawl rather than failing one agent.
    '-m', spec.memory,
    '--memory-swap', spec.memory,

    '--cpus', String(spec.cpus),

    // A fork bomb is a trivially reachable failure mode for an agent running shell.
    '--pids-limit', String(pids),

    // Disk: cap any single file, and cap open descriptors.
    '--ulimit', `fsize=${fsize}`,
    '--ulimit', `nofile=${Math.floor(nofile / 2)}:${nofile}`,

    // Least privilege: no capabilities, no way to gain more.
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',

    // Loopback only: never expose an unsecured opencode server on the network.
    '-p', '127.0.0.1:0:4096',
    '-v', `${spec.hostDir}:/work`,
    ...(spec.authFile
      ? ['-v', `${spec.authFile}:/root/.local/share/opencode/auth.json:ro`]
      : []),
    spec.image,
  ]
}

export async function dockerAvailable(): Promise<boolean> {
  const r = await docker(['info', '--format', '{{.ServerVersion}}'], 20_000)
  return r.code === 0 && r.stdout.trim().length > 0
}

export async function containerState(name: string): Promise<'running' | 'stopped' | 'absent'> {
  const r = await docker(['inspect', '-f', '{{.State.Running}}', name], 20_000)
  if (r.code !== 0) return 'absent'
  return r.stdout.trim() === 'true' ? 'running' : 'stopped'
}

export async function hostPortFor(name: string): Promise<number | null> {
  const r = await docker(['port', name, '4096/tcp'], 20_000)
  if (r.code !== 0) return null
  return parsePortMapping(r.stdout)
}

export async function removeContainer(name: string): Promise<void> {
  await docker(['rm', '-f', name], 30_000)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/docker/cli.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/docker/cli.ts test/runtime/docker/cli.test.ts
git commit -m "feat: add timeout-bounded Docker CLI wrapper"
```

---

## Task 3: Shard planning

Pure function. Gets its own task because a mistake here silently mis-assigns agents to containers,
which surfaces as "some agents can see each other" rather than as an error.

**Files:**
- Create: `src/runtime/docker/shard.ts`
- Test: `test/runtime/docker/shard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { planShards, shardIndexOf } from '../../../src/runtime/docker/shard.js'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`)

describe('planShards', () => {
  test('distributes agents across the requested number of shards', () => {
    const s = planShards(ids(20), 4)
    expect(s).toHaveLength(4)
    expect(s.reduce((n, x) => n + x.agentIds.length, 0)).toBe(20)
  })

  test('balances shard sizes to within one', () => {
    const sizes = planShards(ids(20), 3).map((s) => s.agentIds.length)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
  })

  test('assigns every agent exactly once', () => {
    const all = planShards(ids(17), 5).flatMap((s) => s.agentIds)
    expect(new Set(all).size).toBe(17)
    expect(all).toHaveLength(17)
  })

  test('never creates more shards than agents', () => {
    expect(planShards(ids(3), 10)).toHaveLength(3)
  })

  test('one shard means one container holding everyone', () => {
    const s = planShards(ids(50), 1)
    expect(s).toHaveLength(1)
    expect(s[0]!.agentIds).toHaveLength(50)
  })

  test('shards are numbered from zero contiguously', () => {
    expect(planShards(ids(9), 3).map((s) => s.shardIndex)).toEqual([0, 1, 2])
  })

  test('handles an empty population', () => {
    expect(planShards([], 4)).toEqual([])
  })

  test('throws on a non-positive shard count', () => {
    expect(() => planShards(ids(4), 0)).toThrow(/maxContainers/i)
  })

  test('is deterministic for the same input', () => {
    expect(planShards(ids(11), 3)).toEqual(planShards(ids(11), 3))
  })
})

describe('shardIndexOf', () => {
  test('finds the shard containing an agent', () => {
    const s = planShards(ids(10), 3)
    expect(shardIndexOf(s, 'a1')).toBe(0)
  })

  test('returns null for an unknown agent', () => {
    expect(shardIndexOf(planShards(ids(4), 2), 'nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/docker/shard.test.ts`
Expected: FAIL — cannot resolve `shard.js`.

- [ ] **Step 3: Implement**

```typescript
export interface Shard {
  shardIndex: number
  agentIds: string[]
}

/**
 * Distributes agents across containers.
 *
 * Agents in the same shard share a container and can therefore read and write each
 * other's workspaces. Setting maxContainers equal to the population gives one container
 * per agent and full isolation; setting it to 1 puts everyone together. This is the
 * knob that trades memory against agent-vs-agent isolation.
 */
export function planShards(agentIds: readonly string[], maxContainers: number): Shard[] {
  if (!Number.isInteger(maxContainers) || maxContainers < 1) {
    throw new Error(`maxContainers must be a positive integer, got ${maxContainers}`)
  }
  if (agentIds.length === 0) return []

  const count = Math.min(maxContainers, agentIds.length)
  const shards: Shard[] = Array.from({ length: count }, (_, i) => ({ shardIndex: i, agentIds: [] }))
  // Round-robin keeps sizes balanced to within one and is order-stable.
  agentIds.forEach((id, i) => shards[i % count]!.agentIds.push(id))
  return shards
}

export function shardIndexOf(shards: readonly Shard[], agentId: string): number | null {
  for (const s of shards) {
    if (s.agentIds.includes(agentId)) return s.shardIndex
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/docker/shard.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/docker/shard.ts test/runtime/docker/shard.test.ts
git commit -m "feat: add shard planning for container distribution"
```

---

## Task 4: Image management

**Files:**
- Create: `src/runtime/docker/image.ts`
- Test: `test/runtime/docker/image.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test, vi } from 'vitest'
import { ensureImage } from '../../../src/runtime/docker/image.js'

const ok = { stdout: 'sha256:abc', stderr: '', code: 0 }
const missing = { stdout: '', stderr: 'No such image', code: 1 }

describe('ensureImage', () => {
  test('does not build when the image already exists', async () => {
    const calls: string[][] = []
    const fake = vi.fn(async (args: string[]) => { calls.push(args); return ok })
    await ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake)
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('image')
  })

  test('builds when the image is missing', async () => {
    const calls: string[][] = []
    const fake = vi.fn(async (args: string[]) => {
      calls.push(args)
      return args[0] === 'image' ? missing : ok
    })
    await ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake)
    expect(calls.some((c) => c[0] === 'build')).toBe(true)
  })

  test('passes the tag, dockerfile and context to build', async () => {
    let buildArgs: string[] = []
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'build') buildArgs = args
      return args[0] === 'image' ? missing : ok
    })
    await ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake)
    expect(buildArgs).toContain('agent-arena:latest')
    expect(buildArgs).toContain('docker/Dockerfile.agent')
    expect(buildArgs).toContain('/ctx')
  })

  test('throws with the build output when the build fails', async () => {
    const fake = vi.fn(async (args: string[]) =>
      args[0] === 'image' ? missing : { stdout: '', stderr: 'boom: no space left', code: 1 },
    )
    await expect(
      ensureImage('agent-arena:latest', '/ctx', 'docker/Dockerfile.agent', fake),
    ).rejects.toThrow(/no space left/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/docker/image.test.ts`
Expected: FAIL — cannot resolve `image.js`.

- [ ] **Step 3: Implement**

```typescript
import { docker, type ExecResult } from './cli.js'

export type DockerFn = (args: string[], timeoutMs?: number) => Promise<ExecResult>

/**
 * Ensures the agent image exists, building it if absent.
 * Building takes minutes, so the timeout is generous.
 */
export async function ensureImage(
  tag: string,
  contextDir: string,
  dockerfile: string,
  run: DockerFn = docker,
): Promise<void> {
  const inspect = await run(['image', 'inspect', tag, '-f', '{{.Id}}'], 30_000)
  if (inspect.code === 0) return

  const build = await run(['build', '-t', tag, '-f', dockerfile, contextDir], 900_000)
  if (build.code !== 0) {
    throw new Error(
      `Failed to build ${tag}: ${(build.stderr || build.stdout).slice(-500)}`,
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/docker/image.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/docker/image.ts test/runtime/docker/image.test.ts
git commit -m "feat: add agent image build-if-missing"
```

---

## Task 5: Add `endpoint()` to the Sandbox interface

Each shard has its own container port, so the runner must be able to ask which server an agent
lives on. The design spec specified this method; Phase 2 dropped it because a single local server
made it unnecessary.

**Files:**
- Modify: `src/runtime/sandbox.ts`, `src/runtime/mock-sandbox.ts`, `src/runtime/local-sandbox.ts`
- Test: `test/runtime/mock-sandbox.test.ts`, `test/runtime/local-sandbox.test.ts` (extend both)

- [ ] **Step 1: Add the failing tests**

Append to `test/runtime/mock-sandbox.test.ts` inside the existing describe:

```typescript
  test('endpoint returns the handle base url', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    expect(sb.endpoint(h)).toEqual({ baseUrl: h.baseUrl })
  })
```

Append to `test/runtime/local-sandbox.test.ts` inside the existing describe:

```typescript
  test('endpoint returns an empty base url, since one server serves every agent', async () => {
    const sb = new LocalSandbox(await tmp())
    const h = await sb.provision('a1', {})
    expect(sb.endpoint(h)).toEqual({ baseUrl: '' })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/runtime/mock-sandbox.test.ts test/runtime/local-sandbox.test.ts`
Expected: FAIL — `endpoint` is not a function.

- [ ] **Step 3: Add `endpoint` to the interface in `src/runtime/sandbox.ts`**

Add to the `Sandbox` interface, after `listFiles`:

```typescript
  /**
   * The OpenCode server serving this agent. With one shared local server this is empty
   * and callers use their default client; with Docker each shard has its own port.
   */
  endpoint(handle: AgentHandle): { baseUrl: string }
```

- [ ] **Step 4: Implement in both existing sandboxes**

In `src/runtime/mock-sandbox.ts`:

```typescript
  endpoint(handle: AgentHandle): { baseUrl: string } {
    return { baseUrl: handle.baseUrl }
  }
```

In `src/runtime/local-sandbox.ts`:

```typescript
  endpoint(_handle: AgentHandle): { baseUrl: string } {
    return { baseUrl: '' }
  }
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/sandbox.ts src/runtime/mock-sandbox.ts src/runtime/local-sandbox.ts test/runtime/mock-sandbox.test.ts test/runtime/local-sandbox.test.ts
git commit -m "feat: add endpoint() to the Sandbox interface"
```

---

## Task 6: Container lifecycle

**Files:**
- Create: `src/runtime/docker/container.ts`
- Test: `test/runtime/docker/container.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test, vi } from 'vitest'
import { containerName, startShardContainer, waitForHealth } from '../../../src/runtime/docker/container.js'

describe('containerName', () => {
  test('is stable and includes run and shard', () => {
    expect(containerName('run1', 0)).toBe('arena-run1-0')
    expect(containerName('run1', 3)).toBe('arena-run1-3')
  })
})

describe('waitForHealth', () => {
  test('resolves once the probe succeeds', async () => {
    let n = 0
    await expect(waitForHealth(async () => ++n >= 3, 2000, 5)).resolves.toBe(true)
    expect(n).toBe(3)
  })

  test('resolves false when the deadline passes', async () => {
    await expect(waitForHealth(async () => false, 60, 5)).resolves.toBe(false)
  })
})

describe('startShardContainer', () => {
  const spec = {
    runId: 'run1', shardIndex: 0, image: 'agent-arena:latest',
    hostDir: '/host/shard-0', memory: '1g', cpus: 1, authFile: null,
  }

  test('reuses an already-running container instead of recreating it', async () => {
    const calls: string[][] = []
    const fake = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'inspect') return { stdout: 'true', stderr: '', code: 0 }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:32769', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    const r = await startShardContainer(spec, fake, async () => true)
    expect(r.baseUrl).toBe('http://127.0.0.1:32769')
    expect(calls.some((c) => c[0] === 'run')).toBe(false)
  })

  test('removes a stopped container before starting a fresh one', async () => {
    const calls: string[][] = []
    let running = false
    const fake = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'inspect') return { stdout: running ? 'true' : 'false', stderr: '', code: 0 }
      if (args[0] === 'run') { running = true; return { stdout: 'cid', stderr: '', code: 0 } }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:41000', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    const r = await startShardContainer(spec, fake, async () => true)
    expect(calls.some((c) => c[0] === 'rm')).toBe(true)
    expect(calls.some((c) => c[0] === 'run')).toBe(true)
    expect(r.baseUrl).toBe('http://127.0.0.1:41000')
  })

  test('throws when the container starts but never becomes healthy', async () => {
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: 'false', stderr: '', code: 0 }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:41000', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    await expect(
      startShardContainer({ ...spec, healthTimeoutMs: 100 }, fake, async () => false),
    ).rejects.toThrow(/health/i)
  })

  test('throws when no port could be discovered', async () => {
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: 'false', stderr: '', code: 0 }
      if (args[0] === 'port') return { stdout: '', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    await expect(startShardContainer(spec, fake, async () => true)).rejects.toThrow(/port/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/docker/container.test.ts`
Expected: FAIL — cannot resolve `container.js`.

- [ ] **Step 3: Implement**

```typescript
import { buildRunArgs, docker, parsePortMapping } from './cli.js'
import type { DockerFn } from './image.js'

export interface ShardContainerSpec {
  runId: string
  shardIndex: number
  image: string
  hostDir: string
  memory: string
  cpus: number
  authFile: string | null
  healthTimeoutMs?: number
}

export interface ShardContainer {
  name: string
  baseUrl: string
  shardIndex: number
}

/** Stable name so a restarted orchestrator can find and adopt existing containers. */
export function containerName(runId: string, shardIndex: number): string {
  return `arena-${runId}-${shardIndex}`
}

export async function waitForHealth(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

export async function startShardContainer(
  spec: ShardContainerSpec,
  run: DockerFn = docker,
  healthProbe?: (baseUrl: string) => Promise<boolean>,
): Promise<ShardContainer> {
  const name = containerName(spec.runId, spec.shardIndex)

  const state = await run(['inspect', '-f', '{{.State.Running}}', name], 20_000)
  const running = state.code === 0 && state.stdout.trim() === 'true'

  if (!running) {
    // A stopped container with our name would block `docker run --name`.
    if (state.code === 0) await run(['rm', '-f', name], 30_000)
    const created = await run(
      buildRunArgs({
        name,
        image: spec.image,
        hostDir: spec.hostDir,
        memory: spec.memory,
        cpus: spec.cpus,
        authFile: spec.authFile,
      }),
      120_000,
    )
    if (created.code !== 0) {
      throw new Error(`Failed to start ${name}: ${(created.stderr || created.stdout).slice(-400)}`)
    }
  }

  const portOut = await run(['port', name, '4096/tcp'], 20_000)
  const port = parsePortMapping(portOut.stdout)
  if (port === null) {
    throw new Error(`Could not discover a published port for ${name}`)
  }
  const baseUrl = `http://127.0.0.1:${port}`

  if (healthProbe) {
    const healthy = await waitForHealth(
      () => healthProbe(baseUrl),
      spec.healthTimeoutMs ?? 60_000,
    )
    if (!healthy) {
      throw new Error(`Container ${name} started but never became healthy at ${baseUrl}`)
    }
  }

  return { name, baseUrl, shardIndex: spec.shardIndex }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/docker/container.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/docker/container.ts test/runtime/docker/container.test.ts
git commit -m "feat: add shard container lifecycle with adoption and health wait"
```

---

## Task 7: DockerSandbox

The host-path/container-path distinction lives here and nowhere else.

**Files:**
- Create: `src/runtime/docker/sandbox.ts`
- Test: `test/runtime/docker/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DockerSandbox } from '../../../src/runtime/docker/sandbox.js'

const dirs: string[] = []
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'arena-docker-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** Stands in for the container layer so these tests need no Docker daemon. */
const fakeContainers = () => {
  const started: { shardIndex: number; hostDir: string }[] = []
  const stopped: string[] = []
  return {
    started,
    stopped,
    start: async (shardIndex: number, hostDir: string) => {
      started.push({ shardIndex, hostDir })
      return { name: `arena-t-${shardIndex}`, baseUrl: `http://127.0.0.1:${40000 + shardIndex}`, shardIndex }
    },
    stop: async (name: string) => { stopped.push(name) },
  }
}

const make = async (agentIds: string[], maxContainers: number) => {
  const root = await tmp()
  const c = fakeContainers()
  const sb = new DockerSandbox({
    runId: 't', root, maxContainers, image: 'x', memory: '1g', cpus: 1, authFile: null,
    startContainer: c.start, stopContainer: c.stop,
  })
  await sb.planFor(agentIds)
  return { sb, c, root }
}

describe('DockerSandbox', () => {
  test('workspacePath is the CONTAINER path, not the host path', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    expect(h.workspacePath).toBe('/work/a1')
  })

  test('endpoint returns the shard container base url', async () => {
    const { sb } = await make(['a1', 'a2'], 2)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    expect(sb.endpoint(h1).baseUrl).not.toBe(sb.endpoint(h2).baseUrl)
  })

  test('agents in the same shard share a base url', async () => {
    const { sb } = await make(['a1', 'a2'], 1)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    expect(sb.endpoint(h1).baseUrl).toBe(sb.endpoint(h2).baseUrl)
  })

  test('starts one container per shard, not per agent', async () => {
    const { sb, c } = await make(['a1', 'a2', 'a3', 'a4'], 2)
    for (const id of ['a1', 'a2', 'a3', 'a4']) await sb.provision(id, {})
    expect(c.started).toHaveLength(2)
  })

  test('each shard mounts its own directory, isolating shards from each other', async () => {
    const { c, root } = await make(['a1', 'a2'], 2)
    expect(c.started.map((s) => s.hostDir).sort()).toEqual(
      [join(root, 'shard-0'), join(root, 'shard-1')].sort(),
    )
  })

  test('file operations use the host path and round-trip', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'answer')
    expect(await sb.readFile(h, 'SUBMISSION.md')).toBe('answer')
  })

  test('writes nested paths such as the genome file', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, '.opencode/agents/competitor.md', 'genome')
    expect(await sb.readFile(h, '.opencode/agents/competitor.md')).toBe('genome')
  })

  test('listFiles excludes opencode plumbing', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'a')
    await sb.writeFile(h, '.opencode/node_modules/x.js', 'b')
    expect((await sb.listFiles(h)).map((f) => f.path)).toEqual(['SUBMISSION.md'])
  })

  test('reset clears the workspace but keeps the container', async () => {
    const { sb, c } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'X.md', 'data')
    await sb.reset(h, {})
    expect(await sb.readFile(h, 'X.md')).toBeNull()
    expect(c.stopped).toEqual([])
  })

  test('teardown stops every shard container exactly once', async () => {
    const { sb, c } = await make(['a1', 'a2', 'a3'], 2)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    await sb.teardown(h1)
    await sb.teardown(h2)
    expect(new Set(c.stopped).size).toBe(c.stopped.length)
  })

  test('rejects paths escaping the workspace', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await expect(sb.writeFile(h, '../escape.md', 'x')).rejects.toThrow(/escape|outside/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/docker/sandbox.test.ts`
Expected: FAIL — cannot resolve `sandbox.js`.

- [ ] **Step 3: Implement**

```typescript
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { cp } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { FileEntry } from '../../core/types.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from '../sandbox.js'
import { planShards, shardIndexOf, type Shard } from './shard.js'

export interface StartedContainer {
  name: string
  baseUrl: string
  shardIndex: number
}

export interface DockerSandboxOptions {
  runId: string
  /** Host directory holding shard-N subdirectories. */
  root: string
  maxContainers: number
  image: string
  memory: string
  cpus: number
  authFile: string | null
  startContainer: (shardIndex: number, hostDir: string) => Promise<StartedContainer>
  stopContainer: (name: string) => Promise<void>
}

/**
 * Runs agents inside Docker containers, sharded.
 *
 * Agents in one shard share a container and can reach each other's workspaces; agents in
 * different shards cannot, because each shard bind-mounts only its own directory. No agent
 * can reach the host. Set maxContainers equal to the population for full isolation.
 *
 * The critical distinction in this file: `AgentHandle.workspacePath` is the CONTAINER path
 * (`/work/<agentId>`), because it becomes OpenCode's `?directory=` parameter. Orchestrator
 * file operations use the HOST path. Confusing the two is the most likely bug here.
 */
export class DockerSandbox implements Sandbox {
  private shards: Shard[] = []
  private containers = new Map<number, StartedContainer>()
  private live = new Set<string>()

  constructor(private opts: DockerSandboxOptions) {}

  /** Must be called once with the full population before provisioning. */
  async planFor(agentIds: readonly string[]): Promise<void> {
    this.shards = planShards(agentIds, this.opts.maxContainers)
  }

  private shardFor(agentId: string): number {
    const idx = shardIndexOf(this.shards, agentId)
    if (idx === null) {
      throw new Error(`agent ${agentId} was not included in planFor()`)
    }
    return idx
  }

  private shardHostDir(shardIndex: number): string {
    return join(this.opts.root, `shard-${shardIndex}`)
  }

  private hostDirFor(agentId: string): string {
    return join(this.shardHostDir(this.shardFor(agentId)), agentId)
  }

  private assertLive(h: AgentHandle): void {
    if (!this.live.has(h.agentId)) {
      throw new Error(`workspace for ${h.agentId} has been torn down`)
    }
  }

  private safeJoin(agentId: string, relPath: string): string {
    const base = resolve(this.hostDirFor(agentId))
    const target = resolve(base, relPath)
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`path "${relPath}" escapes the workspace`)
    }
    return target
  }

  private async seed(dir: string, opts: ProvisionOpts): Promise<void> {
    await mkdir(dir, { recursive: true })
    if (opts.seedDir) await cp(opts.seedDir, dir, { recursive: true })
  }

  async provision(agentId: string, opts: ProvisionOpts): Promise<AgentHandle> {
    const shardIndex = this.shardFor(agentId)
    await this.seed(this.hostDirFor(agentId), opts)

    let container = this.containers.get(shardIndex)
    if (!container) {
      await mkdir(this.shardHostDir(shardIndex), { recursive: true })
      container = await this.opts.startContainer(shardIndex, this.shardHostDir(shardIndex))
      this.containers.set(shardIndex, container)
    }

    this.live.add(agentId)
    return {
      agentId,
      // CONTAINER path — this becomes OpenCode's ?directory= parameter.
      workspacePath: `/work/${agentId}`,
      baseUrl: container.baseUrl,
    }
  }

  async reset(handle: AgentHandle, opts: ProvisionOpts): Promise<void> {
    this.assertLive(handle)
    const dir = this.hostDirFor(handle.agentId)
    await rm(dir, { recursive: true, force: true })
    await this.seed(dir, opts)
  }

  async writeFile(handle: AgentHandle, relPath: string, content: string): Promise<void> {
    this.assertLive(handle)
    const target = this.safeJoin(handle.agentId, relPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  async readFile(handle: AgentHandle, relPath: string): Promise<string | null> {
    this.assertLive(handle)
    try {
      return await readFile(this.safeJoin(handle.agentId, relPath), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async listFiles(handle: AgentHandle): Promise<FileEntry[]> {
    this.assertLive(handle)
    const base = this.hostDirFor(handle.agentId)
    const out: FileEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        // .opencode is our own plumbing, not agent output; including it would flood
        // the judge's file manifest with node_modules.
        if (e.isDirectory() && e.name === '.opencode') continue
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) {
          const s = await stat(full)
          out.push({ path: relative(base, full).split(sep).join('/'), bytes: s.size })
        }
      }
    }
    await walk(base)
    return out
  }

  endpoint(handle: AgentHandle): { baseUrl: string } {
    return { baseUrl: handle.baseUrl }
  }

  /** Stops the agent's shard container once every agent in that shard is torn down. */
  async teardown(handle: AgentHandle): Promise<void> {
    this.live.delete(handle.agentId)
    const shardIndex = this.shardFor(handle.agentId)
    const shard = this.shards.find((s) => s.shardIndex === shardIndex)
    if (!shard) return
    if (shard.agentIds.some((id) => this.live.has(id))) return

    const container = this.containers.get(shardIndex)
    if (container) {
      this.containers.delete(shardIndex)
      await this.opts.stopContainer(container.name)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/docker/sandbox.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/docker/sandbox.ts test/runtime/docker/sandbox.test.ts
git commit -m "feat: add sharded DockerSandbox"
```

---

## Task 8: Per-shard client resolution in the agent runner

With one local server the runner held a single client. With shards, each agent's server differs.

**Files:**
- Modify: `src/runtime/opencode/agent-runner.ts`
- Test: `test/runtime/opencode/agent-runner.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

```typescript
describe('per-shard client resolution', () => {
  test('uses the client for the handle base url', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const a = new FakeClient(okResponse)
    const b = new FakeClient(okResponse)
    const runner = new OpenCodeAgentRunner(
      (handle) => (handle.baseUrl === h.baseUrl ? (b as never) : (a as never)),
      sb,
    )
    await runner.run(h, ctx('s'))
    expect(b.lastBody).not.toBeNull()
    expect(a.lastBody).toBeNull()
  })

  test('accepts a plain client for the single-server case', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const c = new FakeClient(okResponse)
    const res = await new OpenCodeAgentRunner(c as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('ok')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/opencode/agent-runner.test.ts`
Expected: FAIL — the constructor does not accept a function.

- [ ] **Step 3: Modify `src/runtime/opencode/agent-runner.ts`**

Add the resolver type and accept either form:

```typescript
export type ClientResolver = (handle: AgentHandle) => OpenCodeClient
```

Change the constructor to:

```typescript
  private resolve: ClientResolver

  constructor(client: OpenCodeClient | ClientResolver, private sandbox: Sandbox) {
    this.resolve = typeof client === 'function' ? client : () => client
  }
```

Replace every `this.client.` usage inside `run` with a local `const client = this.resolve(handle)`
taken at the top of the method, then `client.createSession`, `client.prompt`, `client.abort`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/runtime/opencode/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/opencode/agent-runner.ts test/runtime/opencode/agent-runner.test.ts
git commit -m "feat: resolve the OpenCode client per agent shard"
```

---

## Task 9: Driver — teardown and PREPARE failure isolation

Two Phase 2 prerequisites that become live now. `sandbox.teardown` was never called, which leaks a
container per shard. PREPARE provisions sequentially with no error handling, so one container
failing to start aborts the round before any agent runs — and with Docker, provisioning failures
(port exhaustion, image pull, OOM) are the realistic case.

**Files:**
- Modify: `src/engine/driver.ts`
- Test: `test/engine/driver.test.ts` (extend)

- [ ] **Step 1: Add the failing tests**

```typescript
describe('driver sandbox lifecycle', () => {
  test('tears down every agent workspace when the run is disposed', async () => {
    const { engine, repos, sandbox } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    await engine.dispose(run.id)
    const agents = repos.agents.listActive(run.id)
    const h = { agentId: agents[0]!.id, workspacePath: '', baseUrl: '' }
    await expect(sandbox.readFile(h as never, 'GOAL.md')).rejects.toThrow(/torn down/i)
  })

  test('a provisioning failure does not abort the round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, failProvisionFor: 1 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const scores = repos.scores.forRound(round.roundId)
    expect(scores).toHaveLength(4)
    expect(scores.filter((s) => s.score === 0).length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Extend `test/helpers/mock-engine.ts`**

Add `failProvisionFor?: number` to the options. When set, wrap the sandbox so that `provision` throws
for the agent at that index. Return `sandbox` from `makeMockEngine` (it may already be returned from
a Phase 2 change; if so, leave it).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/engine/driver.test.ts`
Expected: FAIL — `engine.dispose` is not a function, and a provisioning failure throws.

- [ ] **Step 4: Modify `src/engine/driver.ts`**

Run PREPARE through the pool so one failure is isolated:

```typescript
      const prepResults = await runPool(prepared, config.concurrency, async (p) => {
        const h = await this.d.sandbox.provision(p.agent.id, {
          seedDir: config.seedDir ?? undefined,
        })
        await this.d.sandbox.reset(h, { seedDir: config.seedDir ?? undefined })
        await this.d.sandbox.writeFile(h, 'NOTES.md', p.genome.notesMd)
        await this.d.sandbox.writeFile(h, 'GOAL.md', input.goalMd)
        await this.d.sandbox.writeFile(
          h,
          '.opencode/agents/competitor.md',
          serializeGenome(p.genome, { label: p.agent.label }),
        )
        return h
      })

      const handles = new Map<string, AgentHandle>()
      const prepFailed = new Set<string>()
      prepResults.forEach((r, i) => {
        const agentId = prepared[i]!.agent.id
        if (r.ok) handles.set(agentId, r.value)
        else prepFailed.add(agentId)
      })
```

In RUN, skip agents whose provisioning failed and record them as errors rather than calling the
runner with a missing handle. In COLLECT, give them `status: 'error'` with the provisioning message.

Add a `dispose` method that tears down every workspace:

```typescript
  /** Releases sandbox resources. With Docker this stops the shard containers. */
  async dispose(runId: string): Promise<void> {
    const agents = this.d.repos.agents.listActive(runId)
    for (const a of agents) {
      await this.d.sandbox
        .teardown({ agentId: a.id, workspacePath: '', baseUrl: '' })
        .catch(() => {})
    }
  }
```

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS. The evolution integration tests must still pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/driver.ts test/engine/driver.test.ts test/helpers/mock-engine.ts
git commit -m "fix: isolate PREPARE failures and dispose sandbox resources"
```

---

## Task 10: CLI wiring and a gated Docker end-to-end test

**Files:**
- Modify: `src/cli.ts`, `src/core/types.ts`
- Create: `test/e2e/docker-tournament.test.ts`
- Test: `test/cli.test.ts` (extend)

- [x] **Step 1: Add the failing tests to `test/cli.test.ts`**

```typescript
describe('CLI docker mode', () => {
  test('docker mode requires a workspace root', async () => {
    await expect(
      runTournamentCli({
        goal: 'g', rounds: 1, population: 2, seed: 1,
        dbPath: ':memory:', criteria: null, mode: 'real', sandbox: 'docker',
      }),
    ).rejects.toThrow(/workspaceRoot/i)
  })

  test('mock mode ignores the sandbox flag entirely', async () => {
    const out = await runTournamentCli({
      goal: 'g', rounds: 2, population: 4, seed: 42,
      dbPath: ':memory:', criteria: null, mode: 'mock', sandbox: 'docker',
    })
    expect(out.rounds).toHaveLength(2)
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `sandbox` is not a recognised option.

- [x] **Step 3: Add `containerMemory`, `containerCpus` and `maxContainers` defaults**

In `src/core/types.ts`, set `DEFAULT_CONFIG.maxContainers` to `4` and `containerMemory` to `'1g'`,
with a comment recording the measurement: ~413 MiB per container under real work against ~5.2 GiB
free on the reference host, so four containers is the safe default and equals the population for
full isolation at small N.

- [x] **Step 4: Wire docker mode in `src/cli.ts`**

Add `sandbox?: 'local' | 'docker'` to `CliOptions`, defaulting to `'local'`. When `'docker'` and
mode is `'real'`:

```typescript
  const image = 'agent-arena:latest'
  await ensureImage(image, process.cwd(), 'docker/Dockerfile.agent')

  const sandbox = new DockerSandbox({
    runId,
    root: opts.workspaceRoot!,
    maxContainers: config.maxContainers,
    image,
    memory: config.containerMemory,
    cpus: config.containerCpus,
    authFile: opts.authFile ?? null,
    startContainer: (shardIndex, hostDir) =>
      startShardContainer(
        { runId, shardIndex, image, hostDir, memory: config.containerMemory, cpus: config.containerCpus, authFile: opts.authFile ?? null },
        undefined,
        async (baseUrl) => new OpenCodeClient({ baseUrl, timeoutMs: 10_000 }).health(),
      ),
    stopContainer: async (name) => { await removeContainer(name) },
  })
```

Resolve the client per shard by passing a resolver to `OpenCodeAgentRunner`, caching one
`OpenCodeClient` per `baseUrl`. Call `await engine.dispose(run.id)` in the `finally` block so
containers are always stopped. Add `--sandbox` and `--auth-file` CLI flags.

- [x] **Step 5: Create the gated end-to-end test `test/e2e/docker-tournament.test.ts`**

```typescript
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { runTournamentCli } from '../../src/cli.js'

const ENABLED = process.env.ARENA_DOCKER_E2E === '1'
const d = describe.skipIf(!ENABLED)

let workspace = ''
afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

d('docker tournament (ARENA_DOCKER_E2E=1)', () => {
  test('runs agents inside containers and produces scored submissions', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'arena-docker-e2e-'))
    const out = await runTournamentCli({
      goal: 'Write a single clear sentence defining what a tournament is.',
      rounds: 1,
      population: 2,
      seed: 42,
      dbPath: ':memory:',
      criteria: 'clarity, accuracy, concision',
      mode: 'real',
      sandbox: 'docker',
      workspaceRoot: workspace,
      workerModels: ['wandb/deepseek-ai/DeepSeek-V4-Flash'],
      judgeModel: 'wandb/zai-org/GLM-5.2',
      reflectModel: 'wandb/deepseek-ai/DeepSeek-V4-Flash',
    })
    expect(out.rounds).toHaveLength(1)
    expect(out.rounds[0]!.meanScore).toBeGreaterThan(0)
  }, 1_800_000)
})
```

- [x] **Step 6: Verify it skips by default**

Run: `npx vitest run test/e2e/docker-tournament.test.ts`
Expected: skipped, exit 0.

- [x] **Step 7: Full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [x] **Step 8: Commit**

```bash
git add src/cli.ts src/core/types.ts test/cli.test.ts test/e2e/docker-tournament.test.ts
git commit -m "feat: add docker sandbox mode to the CLI"
```

---

## Task 11: Host capacity preflight

Docker limits are per-container caps, not reservations — nothing stops the orchestrator asking for
more than the host has. `maxContainers × containerMemory` can exceed available memory, and
`maxContainers × containerCpus` can exceed the host's CPU count, at which point the machine
thrashes. Refuse to start rather than degrade the user's computer.

**Files:**
- Create: `src/runtime/docker/capacity.ts`
- Test: `test/runtime/docker/capacity.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { parseMemoryLimit, planCapacity } from '../../../src/runtime/docker/capacity.js'

describe('parseMemoryLimit', () => {
  test('parses megabytes and gigabytes', () => {
    expect(parseMemoryLimit('512m')).toBe(512 * 1024 * 1024)
    expect(parseMemoryLimit('1g')).toBe(1024 * 1024 * 1024)
    expect(parseMemoryLimit('2G')).toBe(2 * 1024 * 1024 * 1024)
  })

  test('throws on an unparseable limit', () => {
    expect(() => parseMemoryLimit('lots')).toThrow(/memory/i)
  })
})

describe('planCapacity', () => {
  const host = { totalMemoryBytes: 6.69 * 1024 ** 3, usedMemoryBytes: 1.5 * 1024 ** 3, cpus: 16 }

  test('accepts a plan that fits comfortably', () => {
    const r = planCapacity({ containers: 4, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(true)
  })

  test('rejects a plan that exceeds available memory', () => {
    const r = planCapacity({ containers: 20, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/memory/i)
  })

  test('rejects a plan that oversubscribes CPUs', () => {
    const r = planCapacity({ containers: 4, memory: '256m', cpus: 8 }, host)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/cpu/i)
  })

  test('reserves headroom rather than consuming every last byte', () => {
    // 5.19GiB free; 5 x 1g would fit arithmetically but leaves nothing for the host.
    const r = planCapacity({ containers: 5, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(false)
  })

  test('suggests the largest container count that would fit', () => {
    const r = planCapacity({ containers: 20, memory: '1g', cpus: 1 }, host)
    expect(r.suggestedContainers).toBeGreaterThan(0)
    expect(r.suggestedContainers).toBeLessThan(20)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runtime/docker/capacity.test.ts`
Expected: FAIL — cannot resolve `capacity.js`.

- [x] **Step 3: Implement**

```typescript
import { docker } from './cli.js'

export interface HostCapacity {
  totalMemoryBytes: number
  usedMemoryBytes: number
  cpus: number
}

export interface CapacityPlan {
  containers: number
  memory: string
  cpus: number
}

export interface CapacityVerdict {
  ok: boolean
  reason: string | null
  suggestedContainers: number
}

/** Fraction of free memory we are willing to commit; the rest is headroom for the host. */
const HEADROOM = 0.8

export function parseMemoryLimit(limit: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])b?$/i.exec(limit.trim())
  if (!m) throw new Error(`Unparseable memory limit "${limit}"`)
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  const mult = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : 1024 ** 3
  return Math.round(n * mult)
}

export function planCapacity(plan: CapacityPlan, host: HostCapacity): CapacityVerdict {
  const per = parseMemoryLimit(plan.memory)
  const free = Math.max(0, host.totalMemoryBytes - host.usedMemoryBytes)
  const budget = free * HEADROOM
  const fit = Math.max(0, Math.floor(budget / per))

  if (plan.containers * per > budget) {
    const gib = (n: number) => (n / 1024 ** 3).toFixed(2) + 'GiB'
    return {
      ok: false,
      suggestedContainers: fit,
      reason:
        `Requested ${plan.containers} containers x ${plan.memory} = ${gib(plan.containers * per)}, ` +
        `but only ${gib(budget)} of ${gib(free)} free memory is safely committable. ` +
        `Reduce maxContainers to ${fit}, lower containerMemory, or raise Docker's memory allocation.`,
    }
  }

  if (plan.containers * plan.cpus > host.cpus) {
    return {
      ok: false,
      suggestedContainers: Math.max(1, Math.floor(host.cpus / plan.cpus)),
      reason:
        `Requested ${plan.containers} containers x ${plan.cpus} CPU = ${plan.containers * plan.cpus} ` +
        `but the host has ${host.cpus}. Oversubscribing CPUs will make the machine unresponsive.`,
    }
  }

  return { ok: true, reason: null, suggestedContainers: plan.containers }
}

/** Reads live host capacity from the Docker daemon plus currently running containers. */
export async function readHostCapacity(): Promise<HostCapacity> {
  const info = await docker(['info', '--format', '{{.MemTotal}}|{{.NCPU}}'], 20_000)
  const [memStr, cpuStr] = info.stdout.trim().split('|')
  const stats = await docker(
    ['stats', '--no-stream', '--format', '{{.MemUsage}}'],
    40_000,
  )
  let used = 0
  for (const line of stats.stdout.split('\n')) {
    const m = /^([\d.]+)\s*([KMG])iB/i.exec(line.trim())
    if (!m) continue
    const mult = m[2]!.toUpperCase() === 'K' ? 1024 : m[2]!.toUpperCase() === 'M' ? 1024 ** 2 : 1024 ** 3
    used += Number(m[1]) * mult
  }
  return {
    totalMemoryBytes: Number(memStr ?? 0),
    usedMemoryBytes: used,
    cpus: Number(cpuStr ?? 1),
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runtime/docker/capacity.test.ts`
Expected: PASS, 7 tests.

- [x] **Step 5: Commit**

```bash
git add src/runtime/docker/capacity.ts test/runtime/docker/capacity.test.ts
git commit -m "feat: refuse to start a run that would overcommit the host"
```

---

## Task 12: Output capture, tamper detection and workspace quota

> **Implemented with five amendments** (2026-08-26), after review found holes in the design below:
>
> - **(A) The capture TOCTOU window.** Capturing "immediately after the runner returns" is not
>   enough: the runner returning only means the driver stopped waiting. The agent's own session
>   can still be mid-tool-call (certain on the timeout path), and co-tenants of a shared shard
>   are still executing. So `AgentRunner` gained an optional `quiesce(handle)` that aborts the
>   session and waits for the run to actually come back, the driver calls it before every
>   capture, and COLLECT only calls a verdict `verified` once every agent in the round has been
>   confirmed stopped. See "Residual" below for what this does *not* fix.
> - **(B) Every file is hashed**, not only SUBMISSION.md — `Capture.hashes` is a path -> sha256
>   map over the whole manifest, and `verifyCapture` re-reads all of it (plus flags files
>   planted after capture). Bounded by `hashBudget` so a hostile manifest cannot make the
>   orchestrator read a million files.
> - **(C) `maxWorkspaceFiles` defaults to 2000, not 500.** 500 is a false-positive trap: an
>   `npm install` alone exceeds it. The check itself stays — `--pids-limit` does not stop one
>   process from exhausting inodes.
> - **(D) `capturedAt` kept** as audit trail.
>
> - **(E) `sealed` gates the "intact" verdict.** The first implementation of (A) computed
>   `Capture.sealed` and then never read it: `verifyCapture` derived `verified` from the
>   round-wide barrier alone, so a rival that substituted a file *before* the capture read was
>   reported `tampered: false, verified: true` — the system stamping the attacker's file as the
>   victim's own certified work, which is the precise failure (A) exists to prevent. The rule is
>   now asymmetric, because the two directions need different evidence:
>   - a POSITIVE finding needs the barrier and complete hashes; a difference observed once
>     nothing can be writing is a fact, and does not need a sealed capture;
>   - a NEGATIVE finding ("intact") additionally needs `capture.sealed`, since an unsealed
>     capture may already hold the substitute.
>
>   `sealed` is asserted by the driver only when *both* writers are excluded: this agent
>   (`quiesce` returned `stopped`) and any co-tenant (`workspaceIsolated(sandbox, handle)`, a
>   capability check that is pessimistic when the sandbox cannot answer). Every agent now gets a
>   `submission.captured` audit event carrying `{sealed, verified, tampered, hashesComplete}`,
>   so "checked and clean" is distinguishable from "could not be checked" — absence of a
>   `submission.tampered` event is not a clean bill of health.
>
> **Residual, unfixable by capture timing:** in shared-shard mode a rival can overwrite a
> workspace *while its owner is still running*, and that is indistinguishable from the owner's
> own writes — no capture schedule detects it. The only closures are one container per agent
> (`maxContainers >= populationSize`) or stopping the whole shard container before reading any
> workspace in it. **`DEFAULT_CONFIG` does not currently satisfy this**: `populationSize: 20`
> against `maxContainers: 4` is five co-tenants per container, so under the defaults no capture
> is ever sealed and every honest verdict is `verified: false`. That is the truthful report of
> the guarantee available at that setting, not a bug in capture — but it does mean tamper
> *detection* (the positive direction) is the only protection the default config actually buys.
> Closing it needs either `maxContainers >= populationSize` (a memory decision, measured in
> Task 11 as four 1g containers) or `DockerSandbox.isolatedWorkspace()` reporting per-shard
> occupancy so the distinction is at least visible per agent.

Three guardrails that sit at the boundary between an agent finishing and its work being judged.

**Files:**
- Create: `src/engine/capture.ts`
- Test: `test/engine/capture.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { captureSubmission, verifyCapture, checkQuota } from '../../src/engine/capture.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'

const setup = async () => {
  const sb = new MockSandbox()
  const h = await sb.provision('a1', {})
  return { sb, h }
}

describe('captureSubmission', () => {
  test('captures the submission text and its hash', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'my answer')
    const c = await captureSubmission(sb, h)
    expect(c.submissionMd).toBe('my answer')
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('records a null submission when the file is absent', async () => {
    const { sb, h } = await setup()
    const c = await captureSubmission(sb, h)
    expect(c.submissionMd).toBeNull()
    expect(c.sha256).toBeNull()
  })

  test('captures the file manifest alongside', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    await sb.writeFile(h, 'notes.txt', 'yy')
    const c = await captureSubmission(sb, h)
    expect(c.files.map((f) => f.path).sort()).toEqual(['SUBMISSION.md', 'notes.txt'])
  })
})

describe('verifyCapture', () => {
  test('reports intact when the file is unchanged', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h)
    expect((await verifyCapture(sb, h, c)).tampered).toBe(false)
  })

  test('detects a submission modified after capture', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h)
    await sb.writeFile(h, 'SUBMISSION.md', 'sabotaged')
    expect((await verifyCapture(sb, h, c)).tampered).toBe(true)
  })

  test('detects a submission deleted after capture', async () => {
    const { sb, h } = await setup()
    await sb.writeFile(h, 'SUBMISSION.md', 'original')
    const c = await captureSubmission(sb, h)
    await sb.reset(h, {})
    const v = await verifyCapture(sb, h, c)
    expect(v.tampered).toBe(true)
    expect(v.detail).toMatch(/missing|deleted/i)
  })

  test('an agent that never submitted is not reported as tampered', async () => {
    const { sb, h } = await setup()
    const c = await captureSubmission(sb, h)
    expect((await verifyCapture(sb, h, c)).tampered).toBe(false)
  })
})

describe('checkQuota', () => {
  test('passes a workspace under the limit', () => {
    expect(checkQuota([{ path: 'a', bytes: 100 }], { maxBytes: 1000, maxFiles: 10 }).ok).toBe(true)
  })

  test('fails a workspace over the byte limit', () => {
    const r = checkQuota([{ path: 'a', bytes: 5000 }], { maxBytes: 1000, maxFiles: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/bytes|size/i)
  })

  test('fails a workspace over the file-count limit', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}`, bytes: 1 }))
    const r = checkQuota(files, { maxBytes: 1_000_000, maxFiles: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/files/i)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/capture.test.ts`
Expected: FAIL — cannot resolve `capture.js`.

- [x] **Step 3: Implement**

```typescript
import { createHash } from 'node:crypto'
import type { FileEntry } from '../core/types.js'
import type { AgentHandle, Sandbox } from '../runtime/sandbox.js'

export const SUBMISSION_FILE = 'SUBMISSION.md'

export interface Capture {
  submissionMd: string | null
  sha256: string | null
  files: FileEntry[]
  capturedAt: number
}

const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * Reads an agent's output the moment it finishes, rather than after the whole round.
 *
 * Agents in a shared container can reach each other's workspaces, and a tournament that
 * rewards rank can evolve toward deleting a rival's submission. Capturing immediately
 * shrinks the window in which that sabotage can destroy already-produced work.
 */
export async function captureSubmission(sandbox: Sandbox, handle: AgentHandle): Promise<Capture> {
  const submissionMd = await sandbox.readFile(handle, SUBMISSION_FILE)
  const files = await sandbox.listFiles(handle)
  return {
    submissionMd,
    sha256: submissionMd === null ? null : hash(submissionMd),
    files,
    capturedAt: Date.now(),
  }
}

export interface TamperVerdict {
  tampered: boolean
  detail: string | null
}

/** Re-reads at collect time and compares against the capture. */
export async function verifyCapture(
  sandbox: Sandbox,
  handle: AgentHandle,
  capture: Capture,
): Promise<TamperVerdict> {
  const now = await sandbox.readFile(handle, SUBMISSION_FILE)

  if (capture.sha256 === null) {
    // Nothing was captured, so nothing could be destroyed.
    return { tampered: false, detail: null }
  }
  if (now === null) {
    return { tampered: true, detail: 'submission was deleted after it was captured' }
  }
  if (hash(now) !== capture.sha256) {
    return { tampered: true, detail: 'submission was modified after it was captured' }
  }
  return { tampered: false, detail: null }
}

export interface Quota {
  maxBytes: number
  maxFiles: number
}

export interface QuotaVerdict {
  ok: boolean
  reason: string | null
  totalBytes: number
  fileCount: number
}

/**
 * Caps what one agent may leave behind. Docker's `fsize` ulimit bounds a single file;
 * this bounds the workspace as a whole, which a loop writing many small files would
 * otherwise grow without limit.
 */
export function checkQuota(files: readonly FileEntry[], quota: Quota): QuotaVerdict {
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  const fileCount = files.length

  if (fileCount > quota.maxFiles) {
    return {
      ok: false,
      totalBytes,
      fileCount,
      reason: `workspace holds ${fileCount} files, limit is ${quota.maxFiles}`,
    }
  }
  if (totalBytes > quota.maxBytes) {
    return {
      ok: false,
      totalBytes,
      fileCount,
      reason: `workspace holds ${totalBytes} bytes, limit is ${quota.maxBytes}`,
    }
  }
  return { ok: true, reason: null, totalBytes, fileCount }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/engine/capture.test.ts`
Expected: PASS, 11 tests.

- [x] **Step 5: Wire it into the driver**

In `src/engine/driver.ts`, inside the RUN pool worker, call `captureSubmission` immediately after
the runner returns, and keep the capture per agent. In COLLECT, use the **captured** text as the
judged artifact rather than re-reading the file, call `verifyCapture`, and call `checkQuota` on the
captured manifest.

An agent whose capture was tampered with keeps its captured submission (it earned it) but the event
is recorded in the `events` table with type `submission.tampered`. An agent that **exceeds quota**
gets `status: 'error'` with the quota reason, so it scores 0 — the agent that filled the disk is the
one penalised.

Add the quota fields to `RunConfig` with defaults: `maxWorkspaceBytes: 52_428_800` (50MB),
`maxWorkspaceFiles: 500`.

- [x] **Step 6: Add driver tests**

```typescript
describe('driver capture guardrails', () => {
  test('an agent exceeding the workspace quota is scored zero', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, floodFilesFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const subs = repos.submissions.forRound(round.roundId)
    expect(subs.some((s) => s.status === 'error' && /limit/i.test(s.errorText ?? ''))).toBe(true)
  })

  test('the round completes despite a quota violation', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, floodFilesFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })
})
```

Add a `floodFilesFor?: number` option to `makeMockEngine` that makes the runner for that agent index
write more files than the quota allows.

- [x] **Step 7: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/engine/capture.ts src/engine/driver.ts src/core/types.ts test/engine/capture.test.ts test/engine/driver.test.ts test/helpers/mock-engine.ts
git commit -m "feat: capture output immediately, detect tampering, enforce workspace quota"
```

---

## Task 13: Cost and token budgets

Container limits protect the machine. Nothing yet protects the wallet — a runaway round can spend
without bound. Agents are selected on outcome, so a strategy that happens to burn tokens is
something the tournament can drift toward.

**Files:**
- Create: `src/engine/budget.ts`
- Test: `test/engine/budget.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest'
import { BudgetTracker } from '../../src/engine/budget.js'

describe('BudgetTracker', () => {
  test('accumulates spend', () => {
    const b = new BudgetTracker({ maxRunUsd: 10, maxRoundUsd: 5 })
    b.record(1.5)
    b.record(2)
    expect(b.runSpend).toBeCloseTo(3.5)
  })

  test('reports remaining run budget', () => {
    const b = new BudgetTracker({ maxRunUsd: 10, maxRoundUsd: 5 })
    b.record(4)
    expect(b.remainingRun).toBeCloseTo(6)
  })

  test('is not exceeded below the limits', () => {
    const b = new BudgetTracker({ maxRunUsd: 10, maxRoundUsd: 5 })
    b.record(4)
    expect(b.exceeded()).toBeNull()
  })

  test('detects a round budget breach', () => {
    const b = new BudgetTracker({ maxRunUsd: 100, maxRoundUsd: 5 })
    b.record(6)
    expect(b.exceeded()).toMatch(/round/i)
  })

  test('detects a run budget breach', () => {
    const b = new BudgetTracker({ maxRunUsd: 5, maxRoundUsd: 100 })
    b.record(6)
    expect(b.exceeded()).toMatch(/run/i)
  })

  test('startRound resets round spend but not run spend', () => {
    const b = new BudgetTracker({ maxRunUsd: 100, maxRoundUsd: 5 })
    b.record(4)
    b.startRound()
    expect(b.roundSpend).toBe(0)
    expect(b.runSpend).toBeCloseTo(4)
  })

  test('zero or negative limits mean unlimited', () => {
    const b = new BudgetTracker({ maxRunUsd: 0, maxRoundUsd: 0 })
    b.record(1000)
    expect(b.exceeded()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/engine/budget.test.ts`
Expected: FAIL — cannot resolve `budget.js`.

- [ ] **Step 3: Implement**

```typescript
export interface BudgetLimits {
  /** Zero or negative means unlimited. */
  maxRunUsd: number
  maxRoundUsd: number
}

/** Tracks spend so a runaway tournament stops rather than billing without bound. */
export class BudgetTracker {
  public runSpend = 0
  public roundSpend = 0

  constructor(private limits: BudgetLimits) {}

  startRound(): void {
    this.roundSpend = 0
  }

  record(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return
    this.runSpend += costUsd
    this.roundSpend += costUsd
  }

  get remainingRun(): number {
    return this.limits.maxRunUsd > 0 ? this.limits.maxRunUsd - this.runSpend : Infinity
  }

  /** Returns a human-readable reason when a limit is breached, else null. */
  exceeded(): string | null {
    if (this.limits.maxRoundUsd > 0 && this.roundSpend > this.limits.maxRoundUsd) {
      return `round budget exceeded: spent $${this.roundSpend.toFixed(4)} of $${this.limits.maxRoundUsd}`
    }
    if (this.limits.maxRunUsd > 0 && this.runSpend > this.limits.maxRunUsd) {
      return `run budget exceeded: spent $${this.runSpend.toFixed(4)} of $${this.limits.maxRunUsd}`
    }
    return null
  }
}
```

- [ ] **Step 4: Wire into the driver**

Add `budget: { maxRunUsd: number; maxRoundUsd: number }` to `RunConfig`, defaulting to
`{ maxRunUsd: 5, maxRoundUsd: 1 }` — deliberately low, so an unattended run cannot quietly spend a
lot before anyone notices.

The engine holds one `BudgetTracker` per run. Call `startRound()` at the start of each round, and
`record()` for every agent result and every judge or reflect call. Check `exceeded()` after the RUN
phase: if breached, finish scoring what already ran (that work is paid for either way), skip
reflection, mark the round complete, and surface the reason so the caller can stop.

The CLI stops the loop when the budget is exhausted and prints what was spent.

- [ ] **Step 5: Add a driver test**

```typescript
test('a round that breaches the budget still completes and reports it', async () => {
  const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, costPerAgent: 10 })
  const run = engine.createRun('t', 'goal')
  const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
  expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  expect(round.budgetExceeded).toMatch(/budget/i)
})
```

Add a `costPerAgent?: number` option to `makeMockEngine` that makes the mock runner report that cost.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/engine/budget.ts src/engine/driver.ts src/core/types.ts test/engine/budget.test.ts test/engine/driver.test.ts test/helpers/mock-engine.ts
git commit -m "feat: enforce per-round and per-run cost budgets"
```

---

## Self-review

**Spec coverage.** Design spec §11 (Docker specifics, sharding, container persistence across
rounds) → Tasks 1, 2, 4, 6, 7, 10. Networking: containers use the default bridge so opencode can
reach providers, and agent browsing is blocked by `permission.webfetch: deny` already in the genome
— unchanged from Phase 1, no new work. Phase 2 prerequisites 1, 2, 4 and 14 (container lifecycle,
PREPARE isolation, teardown, `endpoint()`) → Tasks 5, 7, 9.

**Deliberately out of scope:** the allowlist HTTP proxy mentioned in spec §11 as optional hardening.
Bridge networking plus a denied browsing tool is the specified default; a proxy is a later
refinement.

**Type consistency.** `Sandbox` gains `endpoint(handle)` in Task 5 and all three implementations are
updated in the same task, with `DockerSandbox` added in Task 7. `OpenCodeAgentRunner`'s constructor
accepts either a client or a resolver, so Phase 2 call sites keep compiling. `StartedContainer` and
`ShardContainer` describe the same shape — Task 7 imports the type it needs rather than redefining
it.

**One risk worth stating.** `DockerSandbox.planFor` must be called with the full population before
any `provision`. The driver calls `provision` per agent inside PREPARE, so the CLI must call
`planFor` when the run is created and again whenever the population changes. Task 7's `shardFor`
throws a clear error if an agent was never planned, so the failure is loud rather than silent.

---

## Guardrail summary

What protects the machine, and at which layer:

| Threat | Guardrail | Where |
|---|---|---|
| Agent reads or writes host files | Container filesystem isolation; only the shard dir is mounted | Task 1, 7 |
| Memory exhaustion / swap thrashing | `-m` plus `--memory-swap` equal to it, so a leak is killed rather than swapped | Task 2 |
| CPU starvation | `--cpus` per container, plus a preflight refusing to oversubscribe host CPUs | Task 2, 11 |
| **GPU abuse** | `--gpus` is never passed, so containers have no GPU access at all | Task 2 |
| Fork bomb | `--pids-limit` | Task 2 |
| Disk filled by one huge file | `--ulimit fsize` | Task 2 |
| Disk filled by many small files | Workspace byte and file-count quota, enforced at collect | Task 12 |
| Descriptor exhaustion | `--ulimit nofile` | Task 2 |
| Privilege escalation | `--cap-drop ALL`, `--security-opt no-new-privileges` | Task 2 |
| Host overcommit before anything starts | Capacity preflight with a suggested safe container count | Task 11 |
| Unbounded spend | Per-round and per-run cost budgets, defaulting low | Task 13 |
| Agent hangs forever | Driver-enforced timeout with session abort | Phase 2, already shipped |
| **Agent destroys a rival's submission** | One container per agent by default; immediate capture and tamper detection when sharded | Task 7, 12 |
| Unsecured server exposed on the network | Port published to `127.0.0.1` only | Task 2 |

Two of these deserve emphasis because they are properties of *this* system rather than generic
hardening. Agents are selected on outcome and mutate toward whatever wins, so any reachable strategy
that raises rank — burning tokens, hoarding CPU, deleting a rival's file — is something the
tournament can actively evolve toward rather than merely suffer by accident. The budget ceiling and
the tamper detection exist for that reason.

## Definition of done

- [ ] `npm test` passes with every test green
- [ ] `npm run typecheck` exits 0
- [ ] `npm run tournament -- --rounds 6 --population 12` still shows mock-mode fitness rising
- [ ] `ARENA_DOCKER_E2E=1 npx vitest run test/e2e/docker-tournament.test.ts` passes
- [ ] A Docker run leaves no `arena-*` containers behind afterwards
- [ ] An agent inside a container cannot read a file on the host outside its mount
- [ ] Starting a run that would overcommit host memory or CPU is refused, with a suggested safe count
- [ ] An agent that exceeds the workspace quota scores zero without aborting the round
- [ ] Deleting another agent's captured submission is detected and recorded, and does not destroy the victim's score
- [ ] A run that breaches its cost budget stops cleanly and reports what it spent
