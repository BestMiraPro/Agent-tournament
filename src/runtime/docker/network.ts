import { docker, type DockerFn } from './cli.js'

/**
 * One internal network per shard: no route out of Docker, no DNS for the host or the internet,
 * and no path to another shard's network (verified on Docker Desktop, September 15 2026). The
 * shard's gateway is the only other member.
 *
 * Ownership is recorded as labels and checked before a network is adopted, so a run never
 * attaches to — or later removes — a network that belongs to anything else.
 */

export const NETWORK_OWNER_LABEL = 'arena.owner=agent-tournament'

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/

export function shardNetworkName(runId: string, shardIndex: number): string {
  return `arena-${runId}-net-${shardIndex}`
}

export async function createShardNetwork(runId: string, shardIndex: number, run: DockerFn = docker): Promise<string> {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`unsafe run id for a network name: ${JSON.stringify(runId)}`)
  const name = shardNetworkName(runId, shardIndex)
  const created = await run(
    ['network', 'create', '--internal', '--label', NETWORK_OWNER_LABEL, '--label', `arena.run=${runId}`, name],
    30_000,
  )
  if (created.code === 0) return name
  if (/already exists/i.test(created.stderr)) {
    const owner = await run(['network', 'inspect', '-f', '{{index .Labels "arena.run"}}', name], 20_000)
    const label = owner.stdout.trim()
    if (owner.code === 0 && label === runId) return name
    throw new Error(
      `Network ${name} already exists and belongs to "${label || 'nobody'}", not run ${runId}; it was left untouched.`,
    )
  }
  throw new Error(`Could not create network ${name}: ${(created.stderr || created.stdout).trim().slice(-300)}`)
}

/** Never throws. A network already gone counts as removed; anything else is reported. */
export async function removeShardNetwork(
  name: string,
  onWarning?: (message: string) => void,
  run: DockerFn = docker,
): Promise<boolean> {
  const warn = (detail: string) =>
    onWarning?.(`Could not remove network ${name}: ${detail}. Remove it with \`docker network rm ${name}\` once its containers are gone.`)
  try {
    const r = await run(['network', 'rm', name], 30_000)
    if (r.code === 0 || /no such network|not found/i.test(r.stderr)) return true
    warn((r.stderr || r.stdout).trim().slice(-300))
    return false
  } catch (e) {
    warn((e as Error).message)
    return false
  }
}
