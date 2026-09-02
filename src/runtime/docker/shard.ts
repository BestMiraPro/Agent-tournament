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
