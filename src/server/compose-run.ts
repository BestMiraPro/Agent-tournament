import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
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
import { assertHostCapacity, makeClientResolver, sweepBeforeRun, validateRosterModels } from '../cli.js'
import { ensureImage, readImageInventory } from '../runtime/docker/image.js'
import { processLedger, readHostCapacity, type CapacityLedger } from '../runtime/docker/capacity.js'
import {
  containerName,
  inspectContainerState,
  startShardContainer,
  type ProtectedRuntimeSpec,
} from '../runtime/docker/container.js'
import { GATEWAY_ALIAS, GATEWAY_CPUS, GATEWAY_MEMORY_BYTES, GATEWAY_RELAY_PORT } from '../runtime/docker/gateway.js'
import { createShardNetwork, removeShardNetwork } from '../runtime/docker/network.js'
import { relayProviderConfig } from '../runtime/opencode/relay-config.js'
import type { RelayPolicy, RelayUpstream } from '../runtime/provider-relay.js'
import { relayUpstreamsFromAuth, type CatalogProvider } from '../runtime/relay-credentials.js'
import { processRelay } from '../runtime/relay-process.js'
import { RUNTIME_DIR } from '../runtime/runtime-dirs.js'
import type { Placement } from '../runtime/docker/shard.js'
import {
  agentImageTag,
  buildToolManifest,
  digestFolder,
  readToolchainId,
  renderToolsMarkdown,
  TOOLS_MOUNT,
  type DataMount,
  type ImageInventory,
} from '../runtime/tool-manifest.js'
import { CONTAINER_CONTEXT_PATH, removeContainer } from '../runtime/docker/cli.js'
import { sweepOrphanContainers, type SweepOptions } from '../runtime/docker/sweep.js'
import { DockerSandbox } from '../runtime/docker/sandbox.js'
import type { RunSpec } from './run-spec.js'

export interface ComposeSeams {
  startHostServer: (opts: { timeoutMs: number; env?: Record<string, string> }) => Promise<ServerHandle>
  attachHostServer: (url: string, timeoutMs: number) => Promise<ServerHandle>
  ensureImageFn: (image: string, contextDir: string, dockerfile: string, toolchainId?: string) => Promise<void>
  /** Identity of the agent toolchain files, which names the image. */
  toolchainId: () => Promise<string>
  /** The inventory an image recorded at build, validated against the toolchain. */
  readImageInventory: (image: string, toolchainId: string) => Promise<ImageInventory>
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
  /** Capacity promised to runs starting or running in this process. */
  ledger: CapacityLedger
  /** The daemon's account of a container's end, to tell an OOM kill from a model failure. */
  inspectContainer: (name: string) => Promise<{ oomKilled: boolean; running: boolean } | null>
  /** The process's provider relay: its policy, and the loopback port shard gateways forward to. */
  relay: () => Promise<{ policy: RelayPolicy; port: number }>
  /** Reads a host file the protected runtime needs (credentials, catalogue) as text. */
  readTextFile: (path: string) => Promise<string>
  createShardNetworkFn: (runId: string, shardIndex: number) => Promise<string>
  removeShardNetworkFn: (name: string, onWarning: (message: string) => void) => Promise<boolean>
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
  ensureImageFn: (image, contextDir, dockerfile, toolchainId) =>
    ensureImage(image, contextDir, dockerfile, undefined, { toolchainId }),
  toolchainId: () => readToolchainId(process.cwd()),
  readImageInventory: (image, toolchainId) => readImageInventory(image, toolchainId),
  readCapacity: readHostCapacity,
  sweepFn: sweepOrphanContainers,
  validateModels: (client, directory, config, onWarning) =>
    validateRosterModels(client, directory, config, { onWarning }),
  startShardContainerFn: startShardContainer,
  removeContainerFn: removeContainer,
  createShardClient: (baseUrl, timeoutMs) => new OpenCodeClient({ baseUrl, timeoutMs }),
  hostModelsFile: () => hostModelsCatalog(process.env, homedir(), existsSync),
  inspectPath: pathKind,
  ledger: processLedger,
  inspectContainer: (name) => inspectContainerState(name),
  relay: () => processRelay(),
  readTextFile: (path) => readFile(path, 'utf8'),
  createShardNetworkFn: (runId, shardIndex) => createShardNetwork(runId, shardIndex),
  removeShardNetworkFn: (name, onWarning) => removeShardNetwork(name, onWarning),
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

export { RUNTIME_DIR }

/** A ceiling on relayed model calls per agent over a run. Token and spend budgets are enforced separately, from usage. */
export const RELAY_REQUESTS_PER_AGENT = 2000

interface RelayPlan {
  upstreams: RelayUpstream[]
  providers: string[]
  catalogJson: string
}

/**
 * What a protected run's relay needs, read on the host before anything starts: the catalogue to
 * pin in workers, and a key for every roster provider. Every provider the relay cannot carry is
 * named at once, and the run is refused — never a silent fall back to mounting credentials into
 * workers. Errors carry file paths and error codes only, never file content.
 */
async function planRelay(spec: RunSpec, config: RunConfig, s: ComposeSeams): Promise<RelayPlan> {
  const modelsFile = s.hostModelsFile()
  if (!modelsFile) {
    throw new Error(
      'Protected isolation needs the host model catalogue (~/.cache/opencode/models.json) to pin in workers, and none was found. ' +
        'Run OpenCode once on this machine so it caches the catalogue, or choose shared isolation.',
    )
  }
  if (!spec.authFile) {
    throw new Error('Protected isolation needs a credentials file for the relay. Set "Credentials file", or choose shared isolation.')
  }
  const read = async (path: string, what: string): Promise<string> => {
    try {
      return await s.readTextFile(path)
    } catch (e) {
      throw new Error(`Could not read the ${what} ${path} (${(e as NodeJS.ErrnoException).code ?? 'unreadable'}).`)
    }
  }
  const catalogJson = await read(modelsFile, 'host model catalogue')
  let catalog: Record<string, CatalogProvider>
  try {
    catalog = JSON.parse(catalogJson) as Record<string, CatalogProvider>
  } catch {
    throw new Error(`The host model catalogue ${modelsFile} is not valid JSON; let OpenCode refresh it, or choose shared isolation.`)
  }
  const providers = [...new Set(config.roster.map((r) => providerOf(r.modelId)))]
  const { upstreams, unsupported } = relayUpstreamsFromAuth(await read(spec.authFile, 'credentials file'), catalog, providers)
  if (unsupported.length > 0) {
    throw new Error(
      `Protected isolation routes model calls through the relay, which cannot carry: ${unsupported.map((u) => u.reason).join('; ')}. ` +
        'Fix those, or choose shared isolation, where workers use the credentials file directly.',
    )
  }
  return { upstreams, providers, catalogJson }
}

export interface ShardServer {
  shardIndex: number
  baseUrl: string
}

/**
 * Bound for OpenCode control calls (sessions, providers, aborts). Agent prompts and grading calls
 * carry the run's own limit instead, which is none by default.
 */
export const CONTROL_REQUEST_TIMEOUT_MS = 600_000

export interface ComposedRun {
  config: RunConfig
  sandbox: Sandbox
  provider: Provider
  /** The agent image's toolchain identity for a docker run; recorded with the round's audit. */
  toolchainId?: string | null
  runner: AgentRunner
  planFor: ((agentIds: readonly string[]) => Promise<void>) | null
  serverHandle: ServerHandle | null
  shardServers: { baseUrl: string }[]
  /** Subscribes to live Docker shard endpoints and replays endpoints already started. */
  onShardServer?: (listener: (server: ShardServer) => void) => () => void
  /** Docker only: each container in the current plan, its agents, and whether they share it. */
  placement?: () => Placement[]
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
    isolation: spec.isolation ?? DEFAULT_CONFIG.isolation,
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
  const absolute = canonicalFolder(resolve(p)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * The folder's real, long-form path. For a path that does not exist yet, its nearest existing
 * ancestor is resolved and the rest appended, so two spellings of one location still compare
 * equal; a path with no resolvable ancestor at all is kept as written.
 */
export function canonicalFolder(p: string): string {
  const missing: string[] = []
  let current = resolve(p)
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return missing.length > 0 ? join(real, ...missing.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return p
      missing.push(basename(current))
      current = parent
    }
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
        `Credentials file ${spec.authFile} ${kind === 'directory' ? 'is a folder, not a credentials file' : 'does not exist'}. ` +
          'Leave "Credentials file" blank to use your OpenCode login, or point it at an auth.json file. ' +
          'For reference material, use "Context folder" instead.',
      )
    }
  }
  if (spec.contextDir) {
    // OpenCode matches permission patterns against a folder's real path, so a short (8.3) or
    // linked spelling left the grader's allow rule matching nothing and every read of the
    // folder was refused (September 15 relay acceptance run). Everything below uses this one.
    const contextDir = canonicalFolder(spec.contextDir)
    spec = { ...spec, contextDir }
    config.contextDir = contextDir
    assertContextFolder(contextDir, workspaceRoot, s.inspectPath)
  }
  // Host reads only, before capacity or any server: a protected run the relay cannot carry is refused now.
  const relayPlan = spec.sandbox === 'docker' && config.isolation === 'protected' ? await planRelay(spec, config, s) : null
  // Each protected shard also runs a gateway, and its ceilings are part of what the run reserves.
  const companion = relayPlan ? { extraMemoryBytes: GATEWAY_MEMORY_BYTES, extraCpus: GATEWAY_CPUS } : {}
  // Per composition: the live run id does not exist until after this returns.
  const reservationId = randomUUID()
  if (spec.sandbox === 'docker') {
    await assertHostCapacity(config, s.readCapacity as never, onWarning, { ledger: s.ledger, reservationId, ...companion })
  }
  let reservedContainers = Math.max(1, Math.min(config.maxContainers, config.populationSize))
  let graderDirectory: string
  let server: ServerHandle
  try {
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
    server = spec.serverUrl
      ? await s.attachHostServer(spec.serverUrl, CONTROL_REQUEST_TIMEOUT_MS)
      : await s.startHostServer({ timeoutMs: CONTROL_REQUEST_TIMEOUT_MS, env: HOST_SERVER_ENV })
  } catch (e) {
    // Nothing is running, so nothing may keep holding the capacity reserved above.
    s.ledger.release(reservationId)
    throw e
  }
  // Set once this run holds a relay grant; revoked first on every way out.
  let revokeRelay = (): void => {}
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
      // Granted before any container work, so every failure below revokes it.
      let relayToken: string | null = null
      let relayPort = 0
      if (relayPlan) {
        const relay = await s.relay()
        relayToken = randomBytes(24).toString('hex')
        relayPort = relay.port
        relay.policy.grant(reservationId, {
          token: relayToken,
          allowedModels: config.roster.map((r) => r.modelId),
          maxRequests: RELAY_REQUESTS_PER_AGENT * Math.max(1, config.populationSize),
          upstreams: relayPlan.upstreams,
        })
        revokeRelay = () => relay.policy.revoke(reservationId)
      }
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
      const toolchainId = await s.toolchainId()
      const image = agentImageTag(toolchainId)
      // docker/ alone is the build context: the repository root would send run data and any
      // user folders beside it to the daemon on every build.
      await s.ensureImageFn(image, join(process.cwd(), 'docker'), 'docker/Dockerfile.agent', toolchainId)
      // Checked before any agent is placed: an image without the research toolchain, or
      // built from different toolchain files, is refused here rather than discovered mid-round.
      const inventory = await s.readImageInventory(image, toolchainId)
      const data: DataMount[] = []
      if (spec.contextDir) {
        const identity = await digestFolder(spec.contextDir).catch((e: Error) => ({
          digest: null,
          note: `not hashed: ${e.message.slice(0, 120)}`,
        }))
        data.push({ name: 'context', mountPath: CONTAINER_CONTEXT_PATH, ...identity })
      }
      const runtimeRoot = join(workspaceRoot, RUNTIME_DIR)
      // Only directories this composition created are ever removed.
      const manifestDirs = new Set<string>()
      const writeToolManifest = async (runId: string, shardIndex: number): Promise<string> => {
        if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`unsafe run id for a runtime directory: ${runId}`)
        const runDir = join(runtimeRoot, runId)
        const dir = join(runDir, `shard-${shardIndex}`)
        await mkdir(dir, { recursive: true })
        manifestDirs.add(runDir)
        const manifest = buildToolManifest({
          runId,
          containerId: containerName(runId, shardIndex),
          inventory,
          data,
          // Nothing below the agent blocks installation yet; the manifest must not claim it does.
          packageInstall: 'not_enforced',
        })
        await writeFile(join(dir, 'tools.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        await writeFile(join(dir, 'TOOLS.md'), renderToolsMarkdown(manifest), 'utf8')
        return dir
      }
      const removeToolManifests = async (): Promise<void> => {
        for (const dir of [...manifestDirs]) {
          try {
            await rm(dir, { recursive: true, force: true })
            manifestDirs.delete(dir)
          } catch (e) {
            onWarning(`Could not remove the tool manifest directory ${dir}: ${(e as Error).message}`)
          }
        }
      }
      // A protected shard's config: the relay provider settings with this run's token, and the host
      // catalogue it pins. Beside the tool manifest, so it is removed with the run's runtime files.
      const writeRelayConfig = async (runId: string, shardIndex: number): Promise<string> => {
        const dir = join(runtimeRoot, runId, `shard-${shardIndex}-config`)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'opencode.json'), relayProviderConfig({
          providers: relayPlan!.providers,
          relayBaseUrl: `http://${GATEWAY_ALIAS}:${GATEWAY_RELAY_PORT}`,
          token: relayToken!,
        }), 'utf8')
        await writeFile(join(dir, 'models.json'), relayPlan!.catalogJson, 'utf8')
        return dir
      }
      const shardNetworks = new Set<string>()
      /** Worker container name → its gateway, removed together. */
      const gateways = new Map<string, string>()
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
                'Check the Credentials file setting (leave it blank to use your OpenCode login):\n' +
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
        image,
        memory: config.containerMemory,
        cpus: config.containerCpus,
        authFile: spec.authFile,
        isolation: config.isolation,
        startContainer: async (shardIndex, hostDir) => {
          // Read live: containers start during the first round, long after the
          // caller has set the holder to the live run id, so a pending-timestamp
          // id never reaches a container name for a live run.
          const runId = opts.runIdHolder ? opts.runIdHolder.value : `pending-${Date.now()}`
          const toolsDir = await writeToolManifest(runId, shardIndex)
          let protectedRuntime: ProtectedRuntimeSpec | undefined
          if (relayPlan) {
            const network = await s.createShardNetworkFn(runId, shardIndex)
            shardNetworks.add(network)
            protectedRuntime = { network, configDir: await writeRelayConfig(runId, shardIndex), relayPort }
          }
          const started = await s.startShardContainerFn(
            {
              runId,
              shardIndex,
              image,
              hostDir,
              toolsDir,
              memory: config.containerMemory,
              cpus: config.containerCpus,
              // A protected worker mounts no credentials and no host catalogue: the relay holds the
              // keys, and the shard's own config folder carries the catalogue copy.
              authFile: relayPlan ? null : spec.authFile,
              contextDir: spec.contextDir,
              modelsFile: relayPlan ? null : modelsFile,
              ...(protectedRuntime ? { protectedRuntime } : {}),
            },
            undefined,
            async (baseUrl) => s.createShardClient(baseUrl, 10_000).health(),
            onWarning,
          )
          if (started.gatewayName) gateways.set(started.name, started.gatewayName)
          // Its usage now sits inside this run's reservation, not on top of it.
          s.ledger.attach(reservationId, started.name)
          if (started.gatewayName) s.ledger.attach(reservationId, started.gatewayName)
          await checkShardCatalog(started.shardIndex, started.baseUrl)
          publishShardServer({ shardIndex: started.shardIndex, baseUrl: started.baseUrl })
          return started
        },
        stopContainer: async (name) => {
          await s.removeContainerFn(name, onWarning)
          const gateway = gateways.get(name)
          if (gateway) {
            await s.removeContainerFn(gateway, onWarning)
            gateways.delete(name)
          }
        },
        onWarning,
      })
      const runner = new OpenCodeAgentRunner(
        makeClientResolver(sandbox, server.client, (baseUrl) =>
          s.createShardClient(baseUrl, CONTROL_REQUEST_TIMEOUT_MS)),
        sandbox,
        {
          onSessionCreated: sessionHook,
          contextPath: spec.contextDir ? CONTAINER_CONTEXT_PATH : null,
          toolsPath: `${TOOLS_MOUNT}/TOOLS.md`,
          // Only the daemon's own record counts as evidence of an OOM kill. Without it the
          // failure stays what the runner saw; CPU throttling has no such record here and is
          // never inferred.
          resourceFailure: async (handle) => {
            const name = sandbox.containerNameFor(handle.agentId)
            if (!name) return null
            const state = await s.inspectContainer(name)
            if (!state?.oomKilled) return null
            return {
              code: 'CONTAINER_OOM',
              message:
                `Container ${name} was stopped for exceeding its ${config.containerMemory} memory limit; ` +
                'this is a resource limit, not a model failure. Raise Memory per container, or give each agent less to hold in memory.',
            }
          },
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
        planFor: async (agentIds) => {
          // A population that outgrew what was admitted is admitted again, against a fresh
          // reading, before any container for it starts.
          const needed = Math.max(1, Math.min(config.maxContainers, agentIds.length))
          if (needed > reservedContainers) {
            await assertHostCapacity(
              { ...config, populationSize: agentIds.length },
              s.readCapacity as never,
              onWarning,
              { ledger: s.ledger, reservationId, ...companion },
            )
            reservedContainers = needed
          }
          await sandbox.planFor(agentIds)
        },
        placement: () => sandbox.placement(),
        serverHandle: server, shardServers,
        onShardServer,
        toolchainId,
        sessionMap, sessionHook, warnings,
        capacity: { committed: Math.min(config.maxContainers, spec.population), maxContainers: config.maxContainers },
        cleanup: async () => {
          // First: from here on this run's workers can make no further model calls.
          revokeRelay()
          await (sandbox as DockerSandbox).disposeAll?.().catch(() => {}) as never
          // Networks and files only once the containers attached to or mounting them are gone.
          for (const network of [...shardNetworks]) {
            if (await s.removeShardNetworkFn(network, onWarning)) shardNetworks.delete(network)
          }
          await removeToolManifests()
          await server.stop().catch(() => {})
          s.ledger.release(reservationId)
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
    revokeRelay()
    await server.stop().catch(() => {})
    s.ledger.release(reservationId)
    throw e
  }
}
