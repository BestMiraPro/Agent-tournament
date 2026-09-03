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
