import { docker, type DockerFn } from './cli.js'
import { parseMemoryLimit } from '../../core/memory.js'

// Re-exported so existing importers keep working; the parser itself lives in core.
export { parseMemoryLimit }

export interface ContainerUsage {
  name: string
  usedBytes: number
}

export interface HostCapacity {
  totalMemoryBytes: number
  usedMemoryBytes: number
  cpus: number
  /** Per-container usage behind `usedMemoryBytes`, so a run's own containers can be told apart. */
  containers?: ContainerUsage[]
}

/** Ceilings other runs in this process already hold, and what their containers were seen using. */
export interface ReservedCapacity {
  memoryBytes: number
  cpus: number
  observedBytes: number
}

const NOTHING_RESERVED: ReservedCapacity = { memoryBytes: 0, cpus: 0, observedBytes: 0 }

export interface CapacityPlan {
  containers: number
  memory: string
  cpus: number
}

export interface CapacityVerdict {
  ok: boolean
  reason: string | null
  suggestedContainers: number
}

/** Fraction of free memory we are willing to commit; the rest is headroom for the host. */
const HEADROOM = 0.8

export function planCapacity(
  plan: CapacityPlan,
  host: HostCapacity,
  reserved: ReservedCapacity = NOTHING_RESERVED,
): CapacityVerdict {
  const per = parseMemoryLimit(plan.memory)

  // Fail closed on unreadable capacity. Every comparison against NaN is false, so a host
  // carrying one sailed through BOTH guards below and came back `ok` — the overcommit
  // preflight approving exactly what it exists to refuse, and saying nothing. Refusing is
  // the safe direction: `readHostCapacity` now throws before reaching here, and
  // `assertHostCapacity` turns that into a warning-and-proceed, so the documented
  // "unreadable host does not block a run" policy still holds on the real path.
  if (
    !Number.isFinite(host.totalMemoryBytes) ||
    !Number.isFinite(host.usedMemoryBytes) ||
    !Number.isFinite(host.cpus)
  ) {
    return {
      ok: false,
      suggestedContainers: 0,
      reason:
        'Host capacity could not be established (non-finite memory or CPU reading), ' +
        'so the requested plan cannot be checked against it.',
    }
  }

  // Other runs' containers are already inside their reserved ceilings, so their observed usage
  // is taken out of "used" before the ceilings are counted — otherwise it is counted twice.
  const usedByOthers = Math.max(0, host.usedMemoryBytes - reserved.observedBytes)
  const free = Math.max(0, host.totalMemoryBytes - usedByOthers)
  const budget = Math.max(0, free * HEADROOM - reserved.memoryBytes)
  const fit = Math.max(0, Math.floor(budget / per))

  if (plan.containers * per > budget) {
    const gib = (n: number) => (n / 1024 ** 3).toFixed(2) + 'GiB'
    return {
      ok: false,
      suggestedContainers: fit,
      reason:
        `Requested ${plan.containers} containers x ${plan.memory} = ${gib(plan.containers * per)}, ` +
        `but only ${gib(budget)} of ${gib(free)} free memory is safely committable` +
        (reserved.memoryBytes > 0 ? ` (${gib(reserved.memoryBytes)} is already reserved by other runs in this app)` : '') +
        '. ' +
        // Every suggestion here is something the operator can actually do: these settings are
        // in the run spec and the dashboard's Docker options, where they once were not.
        (fit > 0
          ? `Lower the container count to ${fit} (fewer agents also means fewer containers), lower`
          : 'Not even one container of that size fits in the memory Docker has free. Lower') +
        ` the memory per container, stop Docker containers you are not using, ` +
        `or raise Docker Desktop's memory limit (Settings, Resources).`,
    }
  }

  if (plan.containers * plan.cpus + reserved.cpus > host.cpus) {
    return {
      ok: false,
      suggestedContainers: Math.max(1, Math.floor(Math.max(0, host.cpus - reserved.cpus) / plan.cpus)),
      reason:
        `Requested ${plan.containers} containers x ${plan.cpus} CPU = ${plan.containers * plan.cpus}` +
        (reserved.cpus > 0 ? `, plus ${reserved.cpus} reserved by other runs in this app,` : '') +
        ` but the host has ${host.cpus}. Oversubscribing CPUs slows every container down, so this preflight does not admit it. ` +
        `Lower the container count or the CPUs per container.`,
    }
  }

  return { ok: true, reason: null, suggestedContainers: plan.containers }
}

export interface CapacityRequest {
  containers: number
  /** Per container. */
  memoryBytes: number
  /** Per container. */
  cpus: number
}

/** `1g` for whole GiB, otherwise whole MiB — the same notation the run settings use. */
function memoryLabel(bytes: number): string {
  return bytes % 1024 ** 3 === 0 ? `${bytes / 1024 ** 3}g` : `${Math.ceil(bytes / 1024 ** 2)}m`
}

/**
 * Capacity this process has promised to runs that are starting or running.
 *
 * Every start reads the same Docker figures, so two runs starting together each saw the same
 * apparent spare memory and could both be admitted into it. Admission here checks and records
 * in one synchronous step against everything already reserved, so the second start sees the
 * first. Reservations are released on setup failure and on disposal. This only covers runs
 * inside this app: another process starting containers can still race the estimate, which the
 * re-read of Docker's usage at every admission narrows but cannot close.
 */
export class CapacityLedger {
  private entries = new Map<string, { request: CapacityRequest; containerNames: Set<string> }>()

  /** Checks `request` against `host` and every other reservation; records it only when it fits. */
  admit(id: string, request: CapacityRequest, host: HostCapacity): CapacityVerdict {
    const others = [...this.entries].filter(([key]) => key !== id).map(([, entry]) => entry)
    // Usage of every attached container is inside a ceiling counted here: other runs' in
    // `memoryBytes`, this run's own in the request being admitted. A run re-admitted to grow
    // used to count its running containers twice, as used memory and as its full request.
    const ceilingContainers = new Set([...this.entries.values()].flatMap((e) => [...e.containerNames]))
    const reserved: ReservedCapacity = {
      memoryBytes: others.reduce((n, e) => n + e.request.containers * e.request.memoryBytes, 0),
      cpus: others.reduce((n, e) => n + e.request.containers * e.request.cpus, 0),
      observedBytes: (host.containers ?? [])
        .filter((c) => ceilingContainers.has(c.name))
        .reduce((n, c) => n + c.usedBytes, 0),
    }
    const verdict = planCapacity(
      { containers: request.containers, memory: memoryLabel(request.memoryBytes), cpus: request.cpus },
      host,
      reserved,
    )
    if (verdict.ok) {
      this.entries.set(id, { request: { ...request }, containerNames: this.entries.get(id)?.containerNames ?? new Set() })
    }
    return verdict
  }

  /** Attributes a started container to a reservation, so its usage is not counted twice. */
  attach(id: string, containerName: string): void {
    this.entries.get(id)?.containerNames.add(containerName)
  }

  release(id: string): void {
    this.entries.delete(id)
  }

  active(): ({ id: string } & CapacityRequest)[] {
    return [...this.entries].map(([id, entry]) => ({ id, ...entry.request }))
  }

  totals(): { memoryBytes: number; cpus: number } {
    return this.active().reduce(
      (t, r) => ({ memoryBytes: t.memoryBytes + r.containers * r.memoryBytes, cpus: t.cpus + r.containers * r.cpus }),
      { memoryBytes: 0, cpus: 0 },
    )
  }
}

/** The one ledger every run in this process is admitted through. */
export const processLedger = new CapacityLedger()

/**
 * Reads live host capacity from the Docker daemon plus currently running containers.
 *
 * Throws rather than guessing. Neither exit status nor numeric validity used to be
 * checked, which failed in two different directions: a daemon that was not running gave
 * `totalMemoryBytes: 0` and the preflight refused the run for "not enough memory" — the
 * wrong reason entirely — while malformed output gave NaN, which made `planCapacity`
 * approve an absurd plan without a word. Saying "I could not tell" is the only honest
 * answer, and `assertHostCapacity` already treats an unreadable host as a warning rather
 * than a refusal.
 */
export async function readHostCapacity(run: DockerFn = docker): Promise<HostCapacity> {
  const info = await run(['info', '--format', '{{.MemTotal}}|{{.NCPU}}'], 20_000)
  if (info.code !== 0) {
    throw new Error(
      `docker info failed (exit ${info.code}), so host capacity is unknown: ` +
        `${(info.stderr || info.stdout).trim().slice(-200)}`,
    )
  }

  const [memStr, cpuStr] = info.stdout.trim().split('|')
  const totalMemoryBytes = Number(memStr)
  const cpus = Number(cpuStr)
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new Error(`docker info reported unusable total memory ${JSON.stringify(memStr ?? null)}`)
  }
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error(`docker info reported an unusable cpu count ${JSON.stringify(cpuStr ?? null)}`)
  }

  const stats = await run(['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}'], 40_000)
  if (stats.code !== 0) {
    // Treating a failed call as zero usage is the over-committing direction: it makes
    // every container already running invisible to the memory budget.
    throw new Error(
      `docker stats failed (exit ${stats.code}), so container memory usage is unknown: ` +
        `${(stats.stderr || stats.stdout).trim().slice(-200)}`,
    )
  }

  // An empty listing is legitimate — it means nothing is running — so it stays 0.
  let used = 0
  const containers: ContainerUsage[] = []
  for (const line of stats.stdout.split('\n')) {
    const m = /^(?:([^|]*)\|)?\s*([\d.]+)\s*([KMG])iB/i.exec(line.trim())
    if (!m) continue
    const unit = m[3]!.toUpperCase()
    const bytes = Number(m[2]) * (unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : 1024 ** 3)
    used += bytes
    if (m[1] !== undefined && m[1].trim() !== '') containers.push({ name: m[1].trim(), usedBytes: bytes })
  }

  return { totalMemoryBytes, usedMemoryBytes: used, cpus, containers }
}
