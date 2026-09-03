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
import { AGENT_IMAGE, assertHostCapacity, makeClientResolver, sweepBeforeRun, validateRosterModels } from '../cli.js'
import { ensureImage } from '../runtime/docker/image.js'
import { readHostCapacity } from '../runtime/docker/capacity.js'
import { startShardContainer } from '../runtime/docker/container.js'
import { removeContainer } from '../runtime/docker/cli.js'
import { sweepOrphanContainers, type SweepOptions } from '../runtime/docker/sweep.js'
import { DockerSandbox } from '../runtime/docker/sandbox.js'
import type { RunSpec } from './run-spec.js'

export interface ComposeSeams {
  startHostServer: (opts: { timeoutMs: number }) => Promise<ServerHandle>
  attachHostServer: (url: string, timeoutMs: number) => Promise<ServerHandle>
  ensureImageFn: (image: string, contextDir: string, dockerfile: string) => Promise<void>
  readCapacity: Parameters<typeof assertHostCapacity>[1]
  sweepFn: (opts: SweepOptions) => Promise<string[]>
  validateModels: (
    client: OpenCodeClient,
    directory: string,
    config: RunConfig,
    onWarning: (message: string) => void,
  ) => Promise<void>
}

/**
 * The real startup functions. The CLI overrides these explicitly (no-op
 * sweep + validateModels, its own hooks) so its behavior is unchanged; the
 * server path runs with the defaults and gets the full (model, role)
 * preflight, host-capacity read, and orphan sweep.
 */
export const defaultSeams: ComposeSeams = {
  startHostServer: (opts) => startServer({ timeoutMs: opts.timeoutMs }),
  attachHostServer: (url, timeoutMs) => attachServer(url, timeoutMs),
  ensureImageFn: (image, contextDir, dockerfile) => ensureImage(image, contextDir, dockerfile),
  readCapacity: readHostCapacity,
  sweepFn: sweepOrphanContainers,
  validateModels: (client, directory, config, onWarning) =>
    validateRosterModels(client, directory, config, { onWarning }),
}

export interface ComposedRun {
  config: RunConfig
  sandbox: Sandbox
  provider: Provider
  runner: AgentRunner
  planFor: ((agentIds: readonly string[]) => Promise<void>) | null
  serverHandle: ServerHandle | null
  shardServers: { baseUrl: string }[]
  sessionMap: Map<string, string>
  sessionHook: (agentId: string, sessionId: string) => void
  warnings: string[]
  capacity: { committed: number; maxContainers: number } | null
  cleanup: () => Promise<void>
}

/**
 * Mirrors the CLI's runIdHolder (cli.ts): a mutable carrier for the live run
 * id, which is only known after `engine.createRun` — after composition. The
 * dashboard passes one so container names and the orphan sweep use the live
 * id; the CLI passes none and keeps the pending-id behavior it has today.
 */
export interface RunIdHolder {
  value: string
}

export function runConfigFor(spec: RunSpec): RunConfig {
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
export async function composeRun(
  spec: RunSpec,
  seams: Partial<ComposeSeams> = {},
  opts: { runIdHolder?: RunIdHolder; reportWarning?: (message: string) => void } = {},
): Promise<ComposedRun> {
  const s: ComposeSeams = { ...defaultSeams, ...seams }
  const config = runConfigFor(spec)
  const warnings: string[] = []
  // `reportWarning` (CLI) prints each warning as it happens, so container failures
  // during rounds reach the console; the array still collects everything for the
  // server path, where the record surfaces them via GET.
  const onWarning = (m: string) => {
    warnings.push(m)
    opts.reportWarning?.(m)
  }
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
  try {
    const provider = new OpenCodeProvider(server.client, workspaceRoot, {
      timeoutMs: config.agentTimeoutMs,
    })
    // validateRosterModels only throws on a fatal outcome (judge/reflect unusable,
    // every worker unusable); partial worker failures come back through onWarning,
    // so a throw here is the fatal case — let it stop the server via the catch below.
    await s.validateModels(server.client, workspaceRoot, config, onWarning)

    if (spec.sandbox === 'docker') {
      // With a holder the caller is the dashboard: it sets the live run id right
      // after engine.createRun and sweeps with it before the first round (the CLI
      // ordering in cli.ts). Sweeping here with a pending id would exclude
      // nothing — on a shared host it could remove another live run's containers
      // — so the sweep is the caller's job whenever a holder is provided.
      if (!opts.runIdHolder) {
        await sweepBeforeRun(config, `pending-${Date.now()}`, {
          readCapacity: s.readCapacity as never,
          sweep: s.sweepFn as never,
        }, onWarning).catch(() => [])
      }
      await s.ensureImageFn(AGENT_IMAGE, process.cwd(), 'docker/Dockerfile.agent')
      const shardServers: { baseUrl: string }[] = []
      const sandbox = new DockerSandbox({
        runId: `pending-${Date.now()}`,
        root: workspaceRoot,
        maxContainers: config.maxContainers,
        image: AGENT_IMAGE,
        memory: config.containerMemory,
        cpus: config.containerCpus,
        authFile: spec.authFile,
        startContainer: async (shardIndex, hostDir) => {
          // Read live: containers start during the first round, long after the
          // caller has set the holder to the live run id, so a pending-timestamp
          // id never reaches a container name for a live run.
          const runId = opts.runIdHolder ? opts.runIdHolder.value : `pending-${Date.now()}`
          const started = await startShardContainer(
            {
              runId,
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
          shardServers.push({ baseUrl: started.baseUrl })
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
      shardServers: [{ baseUrl: '' }],
      sessionMap, sessionHook, warnings,
      capacity: null,
      cleanup: async () => {
        await server.stop().catch(() => {})
      },
    }
  } catch (e) {
    // Anything that fails after the host server starts must not leak the
    // process: stop it, then propagate so the caller can refuse the run.
    await server.stop().catch(() => {})
    throw e
  }
}
