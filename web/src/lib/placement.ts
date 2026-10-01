import { parseMemoryLimit } from '../../../src/core/memory.js'
import { GATEWAY_CPUS, GATEWAY_MEMORY, GATEWAY_MEMORY_BYTES } from '../../../src/runtime/docker/gateway-limits.js'
import { memoryLabel, planCapacity } from '../../../src/runtime/docker/capacity.js'
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

/** Display helper only: the fit DECISION comes from the server's planCapacity below. */
const HEADROOM = 0.8

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`
const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

/**
 * What was measured for each size, labelled with the workload and scope that
 * measured it. Short research workload: scripts/benchmark-toolchain.ts (September 16
 * 2026, OpenCode plus a 2-million-row pandas/DuckDB backtest and pytest, singly and
 * seven at once). Sustained conversation: the same script's sustained mode
 * (September 17 2026, 100 tool-response turns per worker per round over 10 rounds,
 * recycled vs retained lifecycles). A size smaller than the sustained peaks is not
 * a safe default for long agent conversations, whatever the short workload showed.
 */
export function memoryNote(memory: string): string | null {
  switch (memory.trim().toLowerCase()) {
    case '1g':
      return '1g sustained the measured conversation: 100 tool-turn rounds peaked 725–762 MiB per worker, 2 simultaneous protected agents passed three repetitions each, and a third was refused admission — so 1g stays the default.'
    case '768m':
      return '768m completed the short research workload (peak 592 MiB) but not sustained conversations: 100 tool-turn rounds peaked 727–761 MiB per worker — over the 614 MiB ceiling — and a retained worker OOM-died. 1g stays the default.'
    case '512m':
      return '512m ran out of memory in every measured research trial (OpenCode alone uses about 250 MiB). Use 1g.'
    default:
      return `${memory} has not been measured under sustained-conversation workloads; 1g sustained 100 tool-turn rounds with peaks of 725–762 MiB per worker.`
  }
}

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
  let workerBytes: number | null
  try {
    workerBytes = parseMemoryLimit(plan.memory)
  } catch {
    workerBytes = null
  }
  // A protected shard also runs a gateway, and the server reserves its ceilings with the worker's.
  const gateways = plan.isolation === 'protected'
  const perContainer = workerBytes === null ? null : workerBytes + (gateways ? GATEWAY_MEMORY_BYTES : 0)
  const cpusPer = plan.cpus + (gateways ? GATEWAY_CPUS : 0)
  const memoryTotal = perContainer === null ? null : containers * perContainer
  const cpuTotal = containers * cpusPer

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
  } else if (perContainer === null || memoryTotal === null) {
    fit = { state: 'unknown', message: `Memory per container "${plan.memory}" is not a size like 512m or 1g.` }
  } else {
    // The fit DECISION is the server's own admission arithmetic, not a second
    // implementation of it: same per-container ceilings (worker plus gateway),
    // same host reading, same reservations this app already holds. One deliberate
    // difference stays: admission subtracts the observed usage of containers
    // already inside reservations (CapacityLedger tracks their names); this
    // estimate only sees the endpoint's totals, so it passes observedBytes 0 and
    // reads slightly conservative — it never estimates "fits" for a run the
    // server would refuse on memory. The numbers in the messages below are the
    // same inputs displayed, not a second decision.
    const verdict = planCapacity(
      { containers, memory: memoryLabel(perContainer), cpus: cpusPer },
      {
        totalMemoryBytes: capacity.totalMemoryBytes,
        usedMemoryBytes: capacity.usedMemoryBytes,
        cpus: capacity.cpus,
      },
      {
        memoryBytes: capacity.reservedMemoryBytes,
        cpus: capacity.reservedCpus,
        observedBytes: 0,
      },
    )
    const free = Math.max(0, capacity.totalMemoryBytes - capacity.usedMemoryBytes)
    const left = Math.max(0, free * HEADROOM - capacity.reservedMemoryBytes)
    const cpusLeft = Math.max(0, capacity.cpus - capacity.reservedCpus)
    if (!verdict.ok && memoryTotal > left) {
      fit = {
        state: 'does_not_fit',
        message:
          capacity.reservedMemoryBytes > 0
            ? `Estimated not to fit: ${gib(memoryTotal)} needed, ${gib(left)} left after ${gib(capacity.reservedMemoryBytes)} reserved by other runs in this app.`
            : `Estimated not to fit: ${gib(memoryTotal)} needed, ${gib(left)} Docker can commit.`,
      }
    } else if (!verdict.ok) {
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
    memoryNote: memoryNote(plan.memory),
  }
}
