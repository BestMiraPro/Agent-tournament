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

/** One container's planned members, and whether they share it. */
export interface Placement {
  shardIndex: number
  agentIds: string[]
  occupancy: 'single' | 'shared'
}

export function describeShards(shards: readonly Shard[]): Placement[] {
  return shards.map((s) => ({
    shardIndex: s.shardIndex,
    agentIds: [...s.agentIds],
    occupancy: s.agentIds.length === 1 ? 'single' : 'shared',
  }))
}

/**
 * Which agents (numbered 1..population in roster order) would share which container, by the
 * same rule `planShards` applies — so setup can show `[1,5] [2,6] [3,7] [4]` before Start.
 * Placement follows the population's order each round, so a changed population can move an
 * agent to a different container; this previews one population, not a fixed assignment.
 */
export function placementPreview(population: number, maxContainers: number): number[][] {
  const ordinals = Array.from({ length: population }, (_, i) => String(i + 1))
  return planShards(ordinals, maxContainers).map((s) => s.agentIds.map(Number))
}

export function shardIndexOf(shards: readonly Shard[], agentId: string): number | null {
  for (const s of shards) {
    if (s.agentIds.includes(agentId)) return s.shardIndex
  }
  return null
}
