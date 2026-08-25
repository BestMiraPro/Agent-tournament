import { docker } from './cli.js'

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

export function parseMemoryLimit(limit: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])b?$/i.exec(limit.trim())
  if (!m) throw new Error(`Unparseable memory limit "${limit}"`)
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  const mult = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : 1024 ** 3
  return Math.round(n * mult)
}

export function planCapacity(plan: CapacityPlan, host: HostCapacity): CapacityVerdict {
  const per = parseMemoryLimit(plan.memory)
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
        `Reduce maxContainers to ${fit}, lower containerMemory, or raise Docker's memory allocation.`,
    }
  }

  if (plan.containers * plan.cpus > host.cpus) {
    return {
      ok: false,
      suggestedContainers: Math.max(1, Math.floor(host.cpus / plan.cpus)),
      reason:
        `Requested ${plan.containers} containers x ${plan.cpus} CPU = ${plan.containers * plan.cpus} ` +
        `but the host has ${host.cpus}. Oversubscribing CPUs will make the machine unresponsive.`,
    }
  }

  return { ok: true, reason: null, suggestedContainers: plan.containers }
}

/** Reads live host capacity from the Docker daemon plus currently running containers. */
export async function readHostCapacity(): Promise<HostCapacity> {
  const info = await docker(['info', '--format', '{{.MemTotal}}|{{.NCPU}}'], 20_000)
  const [memStr, cpuStr] = info.stdout.trim().split('|')
  const stats = await docker(
    ['stats', '--no-stream', '--format', '{{.MemUsage}}'],
    40_000,
  )
  let used = 0
  for (const line of stats.stdout.split('\n')) {
    const m = /^([\d.]+)\s*([KMG])iB/i.exec(line.trim())
    if (!m) continue
    const mult = m[2]!.toUpperCase() === 'K' ? 1024 : m[2]!.toUpperCase() === 'M' ? 1024 ** 2 : 1024 ** 3
    used += Number(m[1]) * mult
  }
  return {
    totalMemoryBytes: Number(memStr ?? 0),
    usedMemoryBytes: used,
    cpus: Number(cpuStr ?? 1),
  }
}
