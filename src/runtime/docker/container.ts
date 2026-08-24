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
