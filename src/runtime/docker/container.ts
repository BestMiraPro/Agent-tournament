import { buildProtectedRunArgs, buildRunArgs, docker, parsePortMapping, removeContainer } from './cli.js'
import type { DockerFn, ExecResult } from './cli.js'
import { buildGatewayRunArgs, GATEWAY_ALIAS, GATEWAY_API_PORT, gatewayName } from './gateway.js'

/** Where a protected shard's worker gets its network, relay config and relay route. */
export interface ProtectedRuntimeSpec {
  network: string
  /** Host folder with the relay `opencode.json` and a copy of the model catalogue. */
  configDir: string
  /** The host relay's loopback port, which the shard gateway forwards to. */
  relayPort: number
}

export interface ShardContainerSpec {
  runId: string
  shardIndex: number
  image: string
  hostDir: string
  memory: string
  cpus: number
  authFile: string | null
  /** Host folder of reference material, mounted read-only; null when the run has none. */
  contextDir?: string | null
  /** Host folder with this container's tool manifest, mounted read-only at /run/arena. */
  toolsDir?: string | null
  /** Host models.dev catalogue pinned read-only in the container, when the host has one. */
  modelsFile?: string | null
  healthTimeoutMs?: number
  /** Present for protected isolation: no credentials, no egress, served through a gateway. */
  protectedRuntime?: ProtectedRuntimeSpec
}

export interface ShardContainer {
  name: string
  baseUrl: string
  shardIndex: number
  /**
   * The daemon's own identity for the worker, read after a successful start.
   * Termination of an old invocation resolves against this, never the reusable
   * name. Undefined when the daemon would not say (its absence degrades that
   * evidence to unknown, never to a failed start).
   */
  containerId?: string
  /** Protected shards: the gateway container that must be removed with the worker. */
  gatewayName?: string
  network?: string
}

/** Stable name so a restarted orchestrator can find and adopt existing containers. */
export function containerName(runId: string, shardIndex: number): string {
  return `arena-${runId}-${shardIndex}`
}

/**
 * Authoritative runtime state of one container, addressed by its ID.
 *
 * - `stopped`: the container is confirmed exited, dead, or absent.
 * - `running`: it still exists in a state capable of retaining execution —
 *   a paused or restarting worker still holds its execution, so neither counts
 *   as stopped.
 * - `unknown`: Docker is unavailable, permission is denied, output is invalid,
 *   or absence cannot be distinguished from an inspection failure.
 *
 * A bounded request. Unlike `containerState` in cli.ts, a failed inspection is
 * not "absent": only the daemon's own "no such object" is.
 */
export type RuntimeState = 'running' | 'stopped' | 'unknown'

export async function inspectRuntimeState(
  id: string,
  run: DockerFn = docker,
): Promise<RuntimeState> {
  if (!id) return 'unknown'
  let r: ExecResult
  try {
    r = await run(
      ['inspect', '-f', '{{.State.Running}}|{{.State.Paused}}|{{.State.Restarting}}', id],
      20_000,
    )
  } catch {
    return 'unknown'
  }
  if (r.code !== 0) {
    return /no such (object|container)/i.test(`${r.stderr}\n${r.stdout}`) ? 'stopped' : 'unknown'
  }
  const [running, paused, restarting] = r.stdout.trim().split('|')
  const states = [running, paused, restarting].map((v) =>
    v === 'true' ? true : v === 'false' ? false : null,
  )
  if (states.some((v) => v === null)) return 'unknown'
  return states.some((v) => v === true) ? 'running' : 'stopped'
}

/** The daemon's identity for a live container; undefined when it would not say. */
async function readContainerId(name: string, run: DockerFn): Promise<string | undefined> {
  try {
    const r = await run(['inspect', '-f', '{{.Id}}', name], 20_000)
    if (r.code !== 0) return undefined
    const id = r.stdout.trim()
    return id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * What the daemon says about a container's end: whether the kernel OOM-killed it. Null when
 * the daemon cannot say (no such container, unreadable output) — unknown stays unknown.
 */
export async function inspectContainerState(
  name: string,
  run: DockerFn = docker,
): Promise<{ oomKilled: boolean; running: boolean } | null> {
  const r = await run(['inspect', '-f', '{{.State.OOMKilled}}|{{.State.Running}}', name], 20_000)
  if (r.code !== 0) return null
  const [oom, running] = r.stdout.trim().split('|')
  const bool = (v: string | undefined) => (v === 'true' ? true : v === 'false' ? false : null)
  const oomKilled = bool(oom)
  const isRunning = bool(running)
  if (oomKilled === null || isRunning === null) return null
  return { oomKilled, running: isRunning }
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
  onWarning?: (message: string) => void,
): Promise<ShardContainer> {
  if (spec.protectedRuntime) return startProtectedShard(spec, spec.protectedRuntime, run, healthProbe, onWarning)
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
        contextDir: spec.contextDir ?? null,
        toolsDir: spec.toolsDir ?? null,
        modelsFile: spec.modelsFile ?? null,
      }),
      120_000,
    )
    if (created.code !== 0) {
      throw new Error(`Failed to start ${name}: ${(created.stderr || created.stdout).slice(-400)}`)
    }
  }

  // Past this point a container with this name exists and is running — we either just
  // created it or adopted one. Every remaining step can fail, and a throw here would
  // strand it: the caller never receives a ShardContainer, so DockerSandbox never records
  // the name and neither teardown() nor disposeAll() can ever reach it. The container
  // would then outlive the process entirely, holding memory and a published port until
  // someone runs `docker rm -f` by hand. So: own the container from here on, and remove
  // it on any failure path.
  try {
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

    return { name, baseUrl, shardIndex: spec.shardIndex, containerId: await readContainerId(name, run) }
  } catch (e) {
    // An adopted container is removed too: one wearing our name that cannot serve is
    // useless to us and would only be adopted again by the next attempt.
    // Cleanup is best-effort — it must never replace the error that explains the failure,
    // but a cleanup that fails is a leaked container, so it is reported rather than
    // swallowed. removeContainer never throws.
    await removeContainer(name, onWarning, run)
    throw e
  }
}

/**
 * A protected shard: the worker on its internal network, and the gateway that is its only route
 * in (the app's API calls) and out (model calls to the host relay).
 *
 * Never adopts an existing container: one wearing these names was started with another start's
 * relay token and config. From the first `docker run` on, every container this call created is
 * removed on any failure, as the unprotected path does.
 */
async function startProtectedShard(
  spec: ShardContainerSpec,
  runtime: ProtectedRuntimeSpec,
  run: DockerFn,
  healthProbe: ((baseUrl: string) => Promise<boolean>) | undefined,
  onWarning: ((message: string) => void) | undefined,
): Promise<ShardContainer> {
  const name = containerName(spec.runId, spec.shardIndex)
  const gateway = gatewayName(spec.runId, spec.shardIndex)
  if (!spec.toolsDir) throw new Error(`Protected shard ${name} needs its tool manifest directory`)
  await run(['rm', '-f', name], 30_000)
  await run(['rm', '-f', gateway], 30_000)

  const worker = await run(
    buildProtectedRunArgs({
      name,
      image: spec.image,
      hostDir: spec.hostDir,
      memory: spec.memory,
      cpus: spec.cpus,
      network: runtime.network,
      configDir: runtime.configDir,
      toolsDir: spec.toolsDir,
      contextDir: spec.contextDir ?? null,
    }),
    120_000,
  )
  if (worker.code !== 0) throw new Error(`Failed to start ${name}: ${(worker.stderr || worker.stdout).slice(-400)}`)

  let gatewayStarted = false
  try {
    const started = await run(
      buildGatewayRunArgs({ runId: spec.runId, shardIndex: spec.shardIndex, image: spec.image, relayPort: runtime.relayPort }),
      120_000,
    )
    if (started.code !== 0) {
      throw new Error(`Failed to start gateway ${gateway}: ${(started.stderr || started.stdout).trim().slice(-400)}`)
    }
    gatewayStarted = true
    const joined = await run(['network', 'connect', '--alias', GATEWAY_ALIAS, runtime.network, gateway], 30_000)
    if (joined.code !== 0) {
      throw new Error(`Could not connect gateway ${gateway} to ${runtime.network}: ${(joined.stderr || joined.stdout).trim().slice(-300)}`)
    }
    const portOut = await run(['port', gateway, `${GATEWAY_API_PORT}/tcp`], 20_000)
    const port = parsePortMapping(portOut.stdout)
    if (port === null) throw new Error(`Could not discover a published port for ${gateway}`)
    const baseUrl = `http://127.0.0.1:${port}`
    if (healthProbe) {
      const healthy = await waitForHealth(() => healthProbe(baseUrl), spec.healthTimeoutMs ?? 60_000)
      if (!healthy) throw new Error(`Container ${name} started but never became healthy through its gateway at ${baseUrl}`)
    }
    return { name, baseUrl, shardIndex: spec.shardIndex, containerId: await readContainerId(name, run), gatewayName: gateway, network: runtime.network }
  } catch (e) {
    await removeContainer(name, onWarning, run)
    if (gatewayStarted) await removeContainer(gateway, onWarning, run)
    throw e
  }
}
