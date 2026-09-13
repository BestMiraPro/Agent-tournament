import { docker, type DockerFn } from './cli.js'
import { parseMemoryLimit } from '../../core/memory.js'

// Re-exported so existing importers keep working; the parser itself lives in core.
export { parseMemoryLimit }

export interface HostCapacity {
  totalMemoryBytes: number
  usedMemoryBytes: number
  cpus: number
}

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

export function planCapacity(plan: CapacityPlan, host: HostCapacity): CapacityVerdict {
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

  const free = Math.max(0, host.totalMemoryBytes - host.usedMemoryBytes)
  const budget = free * HEADROOM
  const fit = Math.max(0, Math.floor(budget / per))

  if (plan.containers * per > budget) {
    const gib = (n: number) => (n / 1024 ** 3).toFixed(2) + 'GiB'
    return {
      ok: false,
      suggestedContainers: fit,
      reason:
        `Requested ${plan.containers} containers x ${plan.memory} = ${gib(plan.containers * per)}, ` +
        `but only ${gib(budget)} of ${gib(free)} free memory is safely committable. ` +
        // Every suggestion here is something the operator can actually do: these settings are
        // in the run spec and the dashboard's Docker options, where they once were not.
        (fit > 0
          ? `Lower the container count to ${fit} (fewer agents also means fewer containers), lower`
          : 'Not even one container of that size fits in the memory Docker has free. Lower') +
        ` the memory per container, stop Docker containers you are not using, ` +
        `or raise Docker Desktop's memory limit (Settings, Resources).`,
    }
  }

  if (plan.containers * plan.cpus > host.cpus) {
    return {
      ok: false,
      suggestedContainers: Math.max(1, Math.floor(host.cpus / plan.cpus)),
      reason:
        `Requested ${plan.containers} containers x ${plan.cpus} CPU = ${plan.containers * plan.cpus} ` +
        `but the host has ${host.cpus}. Oversubscribing CPUs will make the machine unresponsive. ` +
        `Lower the container count or the CPUs per container.`,
    }
  }

  return { ok: true, reason: null, suggestedContainers: plan.containers }
}

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

  const stats = await run(['stats', '--no-stream', '--format', '{{.MemUsage}}'], 40_000)
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
  for (const line of stats.stdout.split('\n')) {
    const m = /^([\d.]+)\s*([KMG])iB/i.exec(line.trim())
    if (!m) continue
    const mult = m[2]!.toUpperCase() === 'K' ? 1024 : m[2]!.toUpperCase() === 'M' ? 1024 ** 2 : 1024 ** 3
    used += Number(m[1]) * mult
  }

  return { totalMemoryBytes, usedMemoryBytes: used, cpus }
}
