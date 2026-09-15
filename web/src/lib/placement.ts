import { parseMemoryLimit } from '../../../src/core/memory.js'
import { GATEWAY_CPUS, GATEWAY_MEMORY, GATEWAY_MEMORY_BYTES } from '../../../src/runtime/docker/gateway-limits.js'
import { placementPreview } from '../../../src/runtime/docker/shard.js'

/** What GET /api/capacity reports: Docker's reading plus what this app has already reserved. */
export interface CapacityInfo {
  totalMemoryBytes: number
  usedMemoryBytes: number
  cpus: number
  reservedMemoryBytes: number
  reservedCpus: number
}

export interface PlacementPlan {
  population: number
  maxContainers: number
  memory: string
  cpus: number
  isolation: 'protected' | 'shared'
}

export interface SetupEstimate {
  /** `[1,5] [2,6] [3,7] [4]`: agents numbered in roster order, grouped by container. */
  placement: string
  sharing: string
  ceilings: string
  fit: { state: 'fits' | 'does_not_fit' | 'unknown'; message: string }
  /** Set when protected isolation cannot hold this plan; the server refuses it the same way. */
  refusal: string | null
  memoryNote: string | null
}

/** The server admits at most this share of free memory (src/runtime/docker/capacity.ts). */
const HEADROOM = 0.8

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`
const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

/**
 * What a docker run's settings mean before Start: which agents share which container, the
 * summed ceilings, and whether they fit what Docker reported. An estimate — the server
 * re-reads Docker and admits the run itself — so it never claims more than "estimated".
 * Ceilings are limits, not memory set aside at launch; a workload can still run out inside one.
 */
export function setupEstimate(plan: PlacementPlan, capacity: CapacityInfo | null): SetupEstimate {
  const population = Math.max(0, Math.floor(plan.population))
  const maxContainers = Math.max(1, Math.floor(plan.maxContainers))
  const groups = population > 0 ? placementPreview(population, maxContainers) : []
  const containers = groups.length
  let perContainer: number | null
  try {
    perContainer = parseMemoryLimit(plan.memory)
  } catch {
    perContainer = null
  }
  // A protected shard also runs a gateway, and the server reserves its ceilings with the worker's.
  const gateways = plan.isolation === 'protected'
  const memoryTotal = perContainer === null ? null : containers * (perContainer + (gateways ? GATEWAY_MEMORY_BYTES : 0))
  const cpuTotal = containers * (plan.cpus + (gateways ? GATEWAY_CPUS : 0))

  const refusal =
    plan.isolation === 'protected' && population > maxContainers
      ? `Protected isolation needs ${population} containers for ${population} agents. ` +
        `Raise Containers to ${population}, lower the agent count, or choose shared isolation.`
      : null

  let fit: SetupEstimate['fit']
  if (!capacity) {
    fit = {
      state: 'unknown',
      message:
        plan.isolation === 'protected'
          ? 'Docker capacity could not be read: a protected run will be refused until it can be.'
          : 'Docker capacity could not be read: a shared run will start without the memory check.',
    }
  } else if (memoryTotal === null) {
    fit = { state: 'unknown', message: `Memory per container "${plan.memory}" is not a size like 512m or 1g.` }
  } else {
    const free = Math.max(0, capacity.totalMemoryBytes - capacity.usedMemoryBytes)
    const left = Math.max(0, free * HEADROOM - capacity.reservedMemoryBytes)
    const cpusLeft = Math.max(0, capacity.cpus - capacity.reservedCpus)
    if (memoryTotal > left) {
      fit = {
        state: 'does_not_fit',
        message:
          capacity.reservedMemoryBytes > 0
            ? `Estimated not to fit: ${gib(memoryTotal)} needed, ${gib(left)} left after ${gib(capacity.reservedMemoryBytes)} reserved by other runs in this app.`
            : `Estimated not to fit: ${gib(memoryTotal)} needed, ${gib(left)} Docker can commit.`,
      }
    } else if (cpuTotal > cpusLeft) {
      fit = { state: 'does_not_fit', message: `Estimated not to fit: ${count(cpuTotal)} CPUs needed, ${count(cpusLeft)} available.` }
    } else {
      fit = { state: 'fits', message: `Estimated to fit: ${gib(memoryTotal)} of ${gib(left)} Docker can commit.` }
    }
  }

  return {
    placement: groups.map((g) => `[${g.join(',')}]`).join(' '),
    sharing:
      containers === 0
        ? 'No agents yet.'
        : groups.some((g) => g.length > 1)
          ? 'Agents share containers: an agent can read and change the files of the others in its container.'
          : 'Each agent has its own container.',
    ceilings:
      `${containers} container${containers === 1 ? '' : 's'} × ${plan.memory}` +
      (gateways ? ` + ${containers} gateway${containers === 1 ? '' : 's'} × ${GATEWAY_MEMORY}` : '') +
      ` = ${memoryTotal === null ? 'unknown' : gib(memoryTotal)} memory, ${count(cpuTotal)} CPU${cpuTotal === 1 ? '' : 's'}`,
    fit,
    refusal,
    memoryNote:
      plan.memory.trim().toLowerCase() === '1g'
        ? null
        : `${plan.memory} has not been measured under research workloads; 1g is the measured default.`,
  }
}
