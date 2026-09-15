import { buildRunArgs, docker, parsePortMapping, removeContainer } from './cli.js'
import type { DockerFn } from './cli.js'

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
  /** Host models.dev catalogue pinned read-only in the container, when the host has one. */
  modelsFile?: string | null
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
  onWarning?: (message: string) => void,
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
        contextDir: spec.contextDir ?? null,
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

    return { name, baseUrl, shardIndex: spec.shardIndex }
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
