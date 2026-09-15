import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
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
import {
  hasProvider,
  hostModelsCatalog,
  missingModels,
  modelUnavailableMessage,
  providerOf,
  readRuntimeCatalog,
  type RuntimeCatalog,
} from '../runtime/opencode/discovery.js'
import { writeGraderProfile } from '../runtime/opencode/grader-profile.js'
import { attachServer, startServer, type ServerHandle } from '../runtime/opencode/server.js'
import { AGENT_IMAGE, assertHostCapacity, makeClientResolver, sweepBeforeRun, validateRosterModels } from '../cli.js'
import { ensureImage } from '../runtime/docker/image.js'
import { readHostCapacity } from '../runtime/docker/capacity.js'
import { startShardContainer } from '../runtime/docker/container.js'
import { CONTAINER_CONTEXT_PATH, removeContainer } from '../runtime/docker/cli.js'
import { sweepOrphanContainers, type SweepOptions } from '../runtime/docker/sweep.js'
import { DockerSandbox } from '../runtime/docker/sandbox.js'
import type { RunSpec } from './run-spec.js'

export interface ComposeSeams {
  startHostServer: (opts: { timeoutMs: number; env?: Record<string, string> }) => Promise<ServerHandle>
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
  startShardContainerFn: typeof startShardContainer
  removeContainerFn: typeof removeContainer
  /** A client for one shard's own OpenCode server. */
  createShardClient: (baseUrl: string, timeoutMs: number) => OpenCodeClient
  /** The host catalogue file to pin in shards, or null when the host has none. */
  hostModelsFile: () => string | null
  /** What a host path is, so a docker auth file can be checked before anything starts. */
  inspectPath: (path: string) => PathKind
}

export type PathKind = 'file' | 'directory' | 'missing'

export function pathKind(path: string): PathKind {
  try {
    const stat = statSync(path)
    return stat.isDirectory() ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

/**
 * The real startup functions. The CLI overrides these explicitly (no-op
 * sweep + validateModels, its own hooks) so its behavior is unchanged; the
 * server path runs with the defaults and gets the full (model, role)
 * preflight, host-capacity read, and orphan sweep.
 */
export const defaultSeams: ComposeSeams = {
  startHostServer: (opts) => startServer({ timeoutMs: opts.timeoutMs, env: opts.env }),
  attachHostServer: (url, timeoutMs) => attachServer(url, timeoutMs),
  ensureImageFn: (image, contextDir, dockerfile) => ensureImage(image, contextDir, dockerfile),
  readCapacity: readHostCapacity,
  sweepFn: sweepOrphanContainers,
  validateModels: (client, directory, config, onWarning) =>
    validateRosterModels(client, directory, config, { onWarning }),
  startShardContainerFn: startShardContainer,
  removeContainerFn: removeContainer,
  createShardClient: (baseUrl, timeoutMs) => new OpenCodeClient({ baseUrl, timeoutMs }),
  hostModelsFile: () => hostModelsCatalog(process.env, homedir(), existsSync),
  inspectPath: pathKind,
}

/**
 * Environment for the host OpenCode server this app starts.
 *
 * OpenCode 1.18.21 offers `websearch` only to its own `opencode` provider unless Exa search
 * is enabled; with it, the grader can search whatever provider serves it (verified through
 * `GET /experimental/tool`, no prompt sent). Side effect, accepted in the design: local-run
 * workers share this server, so their non-OpenCode models gain `websearch` too. Docker
 * shards run their own servers and are unchanged.
 */
export const HOST_SERVER_ENV: Record<string, string> = { OPENCODE_ENABLE_EXA: '1' }

export interface ShardServer {
  shardIndex: number
  baseUrl: string
}

export interface ComposedRun {
  config: RunConfig
  sandbox: Sandbox
  provider: Provider
  runner: AgentRunner
  planFor: ((agentIds: readonly string[]) => Promise<void>) | null
  serverHandle: ServerHandle | null
  shardServers: { baseUrl: string }[]
  /** Subscribes to live Docker shard endpoints and replays endpoints already started. */
  onShardServer?: (listener: (server: ShardServer) => void) => () => void
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
    selection: { ...DEFAULT_CONFIG.selection, ...spec.selection },
    budget: { ...DEFAULT_CONFIG.budget, ...spec.budget },
    concurrency: spec.concurrency ?? DEFAULT_CONFIG.concurrency,
    maxContainers: spec.maxContainers ?? DEFAULT_CONFIG.maxContainers,
    containerMemory: spec.containerMemory ?? DEFAULT_CONFIG.containerMemory,
    containerCpus: spec.containerCpus ?? DEFAULT_CONFIG.containerCpus,
    pricing: { ...DEFAULT_CONFIG.pricing, ...spec.pricing },
    seedDir: spec.seedDir,
    contextDir: spec.contextDir ?? null,
  }
}

/**
 * Refuses a context folder that is not an existing folder, or that overlaps the workspace
 * root in either direction: agents write under the root, and the folder must stay unchanged.
 */
export function assertContextFolder(
  contextDir: string,
  workspaceRoot: string,
  inspect: (path: string) => PathKind,
): void {
  const kind = inspect(contextDir)
  if (kind !== 'directory') {
    throw new Error(
      `Context folder ${contextDir} ${kind === 'file' ? 'is a file' : 'does not exist'}. ` +
        'Point it at a folder of reference material, or leave it blank.',
    )
  }
  const ctx = comparablePath(contextDir)
  const ws = comparablePath(workspaceRoot)
  if (ws === ctx || ws.startsWith(ctx + sep)) {
    throw new Error(
      `Context folder ${contextDir} must not contain the workspace root ${workspaceRoot}: agents write there, and the folder is meant to stay read-only.`,
    )
  }
  if (ctx.startsWith(ws + sep)) {
    throw new Error(`Context folder ${contextDir} must not be inside the workspace root ${workspaceRoot}: agents could change it.`)
  }
}

function comparablePath(p: string): string {
  const absolute = resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
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
  // Earliest point both the CLI and the server POST path share: opencode
  // realpaths the session directory and 500s when it is missing, so the root
  // must exist before any server starts. Mock mode returns above and never
  // touches fs, so mock tests stay hermetic; recursive mkdir on an existing
  // dir is a no-op.
  try {
    mkdirSync(workspaceRoot, { recursive: true })
  } catch (e) {
    throw new Error(`workspace root ${workspaceRoot}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (spec.sandbox === 'docker' && spec.authFile) {
    // Docker bind-mounts whatever this names where auth.json belongs. A folder there leaves
    // every container without credentials, so each keyed provider fails only after minutes
    // of setup — refuse it now instead.
    const kind = s.inspectPath(spec.authFile)
    if (kind !== 'file') {
      throw new Error(
        `Auth file ${spec.authFile} ${kind === 'directory' ? 'is a folder, not a credentials file' : 'does not exist'}. ` +
          'Leave "Auth file" blank to use your OpenCode login, or point it at an auth.json file.',
      )
    }
  }
  if (spec.contextDir) assertContextFolder(spec.contextDir, workspaceRoot, s.inspectPath)
  if (spec.sandbox === 'docker') {
    await assertHostCapacity(config, s.readCapacity as never, onWarning)
  }
  let graderDirectory: string
  try {
    graderDirectory = writeGraderProfile(workspaceRoot, spec.contextDir ?? null)
  } catch (e) {
    throw new Error(`grader profile under ${workspaceRoot}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (spec.serverUrl) {
    onWarning(
      'Attached to an existing OpenCode server: whether the grader can search the web depends on how that server was started (OPENCODE_ENABLE_EXA=1).',
    )
  }
  const server = spec.serverUrl
    ? await s.attachHostServer(spec.serverUrl, config.agentTimeoutMs)
    : await s.startHostServer({ timeoutMs: config.agentTimeoutMs, env: HOST_SERVER_ENV })
  try {
    const provider = new OpenCodeProvider(server.client, workspaceRoot, {
      timeoutMs: config.agentTimeoutMs,
      graderDirectory,
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
      const modelsFile = s.hostModelsFile()
      // Each shard's catalogue, read once per actual container start and keyed by its
      // endpoint, so a replacement container is checked afresh rather than trusted.
      const shardCatalogs = new Map<string, { shardIndex: number; catalog: RuntimeCatalog }>()
      const reportedCatalogIssues = new Set<string>()
      const reportOnce = (message: string) => {
        if (reportedCatalogIssues.has(message)) return
        reportedCatalogIssues.add(message)
        onWarning(message)
      }
      // Host validation above proves nothing about a shard: it is a separate OpenCode
      // runtime with its own catalogue. Ask the shard itself, before any worker prompt.
      const checkShardCatalog = async (shardIndex: number, baseUrl: string) => {
        shardCatalogs.delete(baseUrl)
        try {
          const catalog = await readRuntimeCatalog(s.createShardClient(baseUrl, 10_000))
          shardCatalogs.set(baseUrl, { shardIndex, catalog })
          const missing = missingModels(catalog, config.roster.map((r) => r.modelId))
          const runtime = `OpenCode ${catalog.version ?? 'version unknown'}`
          const noCredentials = missing.filter((m) => !hasProvider(catalog, providerOf(m)))
          const notListed = missing.filter((m) => hasProvider(catalog, providerOf(m)))
          if (noCredentials.length > 0) {
            const providers = [...new Set(noCredentials.map(providerOf))].map((p) => `"${p}"`).join(', ')
            reportOnce(
              `No credentials for ${providers} reached the Docker runtime (${runtime}); agents on these models will fail before any prompt. ` +
                'Check the Auth file setting (leave it blank to use your OpenCode login):\n' +
                noCredentials.map((m) => `  - ${m}`).join('\n'),
            )
          }
          if (notListed.length > 0) {
            reportOnce(
              `${notListed.length} selected worker model(s) unavailable in Docker runtime ` +
                `(${runtime}); agents on them will fail before any prompt:\n` +
                notListed.map((m) => `  - ${m}`).join('\n'),
            )
          }
        } catch (e) {
          reportOnce(
            `Could not read the model catalogue of Docker shard ${shardIndex}, so its worker models ` +
              `are not checked before prompting: ${(e as Error).message.slice(0, 200)}`,
          )
        }
      }
      const shardServers: ShardServer[] = []
      const shardListeners = new Set<(server: ShardServer) => void>()
      const publishShardServer = (server: ShardServer) => {
        const index = shardServers.findIndex((current) => current.shardIndex === server.shardIndex)
        if (index >= 0 && shardServers[index]!.baseUrl === server.baseUrl) return
        if (index >= 0) shardServers[index] = server
        else shardServers.push(server)
        for (const listener of shardListeners) {
          try {
            listener(server)
          } catch {
            /* a dashboard bridge subscriber must never break container startup */
          }
        }
      }
      const onShardServer = (listener: (server: ShardServer) => void) => {
        shardListeners.add(listener)
        for (const server of shardServers) listener(server)
        return () => { shardListeners.delete(listener) }
      }
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
          const started = await s.startShardContainerFn(
            {
              runId,
              shardIndex,
              image: AGENT_IMAGE,
              hostDir,
              memory: config.containerMemory,
              cpus: config.containerCpus,
              authFile: spec.authFile,
              contextDir: spec.contextDir,
              modelsFile,
            },
            undefined,
            async (baseUrl) => s.createShardClient(baseUrl, 10_000).health(),
            onWarning,
          )
          await checkShardCatalog(started.shardIndex, started.baseUrl)
          publishShardServer({ shardIndex: started.shardIndex, baseUrl: started.baseUrl })
          return started
        },
        stopContainer: async (name) => {
          await s.removeContainerFn(name, onWarning)
        },
        onWarning,
      })
      const runner = new OpenCodeAgentRunner(
        makeClientResolver(sandbox, server.client, (baseUrl) =>
          s.createShardClient(baseUrl, config.agentTimeoutMs)),
        sandbox,
        {
          onSessionCreated: sessionHook,
          contextPath: spec.contextDir ? CONTAINER_CONTEXT_PATH : null,
          // Per agent rather than per roster entry: agents added or bred mid-run carry
          // models the roster check at shard start never saw.
          modelUnavailable: (handle, modelId) => {
            const entry = shardCatalogs.get(sandbox.endpoint(handle).baseUrl)
            if (!entry || entry.catalog.models.has(modelId)) return null
            return modelUnavailableMessage(
              modelId, entry.catalog.version, entry.shardIndex,
              !hasProvider(entry.catalog, providerOf(modelId)),
            )
          },
        },
      )
      return {
        config, sandbox, provider, runner,
        planFor: (agentIds) => sandbox.planFor(agentIds),
        serverHandle: server, shardServers,
        onShardServer,
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
      runner: new OpenCodeAgentRunner(server.client, sandbox, {
        onSessionCreated: sessionHook,
        contextPath: spec.contextDir,
      }),
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
