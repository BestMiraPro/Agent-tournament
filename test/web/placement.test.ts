import { describe, expect, test } from 'vitest'
import { setupEstimate } from '../../web/src/lib/placement.js'
import { planCapacity } from '../../src/runtime/docker/capacity.js'
import { GATEWAY_CPUS, GATEWAY_MEMORY_BYTES } from '../../src/runtime/docker/gateway-limits.js'
import { parseMemoryLimit } from '../../src/core/memory.js'

const GiB = 1024 ** 3
const capacity = { totalMemoryBytes: 8 * GiB, usedMemoryBytes: 1 * GiB, cpus: 16, reservedMemoryBytes: 0, reservedCpus: 0 }
const plan = (over: Partial<Parameters<typeof setupEstimate>[0]> = {}) => ({
  population: 7, maxContainers: 4, memory: '1g', cpus: 1, isolation: 'shared' as const, ...over,
})

describe('setupEstimate', () => {
  test('seven agents on four shared containers: placement, sharing, ceilings and fit', () => {
    const e = setupEstimate(plan(), capacity)
    expect(e.placement).toBe('[1,5] [2,6] [3,7] [4]')
    expect(e.sharing).toBe('Agents share containers: an agent can read and change the files of the others in its container.')
    expect(e.ceilings).toBe('4 containers × 1g = 4.00 GiB memory, 4 CPUs')
    // 0.8 x (8 - 1) = 5.60 GiB committable.
    expect(e.fit).toEqual({ state: 'fits', message: 'Estimated to fit: 4.00 GiB of 5.60 GiB Docker can commit.' })
    expect(e.refusal).toBeNull()
  })

  test('protected isolation with too few containers is refused before Start', () => {
    expect(setupEstimate(plan({ isolation: 'protected' }), capacity).refusal).toBe(
      'Protected isolation needs 7 containers for 7 agents. Raise Containers to 7, lower the agent count, or choose shared isolation.',
    )
  })

  test('one agent per container says so', () => {
    const e = setupEstimate(plan({ population: 3, maxContainers: 8, isolation: 'protected' }), capacity)
    expect(e.placement).toBe('[1] [2] [3]')
    expect(e.sharing).toBe('Each agent has its own container.')
    expect(e.ceilings).toBe('3 containers × 1g + 3 gateways × 64m = 3.19 GiB memory, 3.75 CPUs')
    expect(e.refusal).toBeNull()
  })

  test('capacity reserved by other runs in this app counts against the fit', () => {
    const e = setupEstimate(plan({ population: 4, isolation: 'protected' }), { ...capacity, reservedMemoryBytes: 3 * GiB })
    expect(e.fit).toEqual({
      state: 'does_not_fit',
      message: 'Estimated not to fit: 4.25 GiB needed, 2.60 GiB left after 3.00 GiB reserved by other runs in this app.',
    })
  })

  test('protected isolation counts each shard\'s gateway, exactly as the server reserves it', () => {
    expect(setupEstimate(plan({ population: 4 }), capacity).ceilings).toBe('4 containers × 1g = 4.00 GiB memory, 4 CPUs')
    const protectedPlan = setupEstimate(plan({ population: 4, isolation: 'protected' }), capacity)
    expect(protectedPlan.ceilings).toBe('4 containers × 1g + 4 gateways × 64m = 4.25 GiB memory, 5 CPUs')
    expect(protectedPlan.fit).toEqual({ state: 'fits', message: 'Estimated to fit: 4.25 GiB of 5.60 GiB Docker can commit.' })
  })

  test('a CPU ceiling over the host does not fit', () => {
    expect(setupEstimate(plan({ population: 4, cpus: 8 }), capacity).fit).toEqual({
      state: 'does_not_fit',
      message: 'Estimated not to fit: 32 CPUs needed, 16 available.',
    })
  })

  test('unknown capacity: a protected start will be refused, a shared one is unchecked', () => {
    expect(setupEstimate(plan({ population: 4, isolation: 'protected' }), null).fit).toEqual({
      state: 'unknown',
      message: 'Docker capacity could not be read: a protected run will be refused until it can be.',
    })
    expect(setupEstimate(plan(), null).fit).toEqual({
      state: 'unknown',
      message: 'Docker capacity could not be read: a shared run will start without the memory check.',
    })
  })

  test('each size says what was measured for it, with the workload and scope', () => {
    expect(setupEstimate(plan(), capacity).memoryNote).toContain('2 simultaneous protected agents passed')
    expect(setupEstimate(plan({ memory: '768m' }), capacity).memoryNote).toContain('727–761 MiB')
    expect(setupEstimate(plan({ memory: '512M' }), capacity).memoryNote).toContain('ran out of memory in every measured research trial')
    expect(setupEstimate(plan({ memory: '2g' }), capacity).memoryNote).toBe(
      '2g has not been measured under sustained-conversation workloads; 1g sustained 100 tool-turn rounds with peaks of 725–762 MiB per worker.',
    )
  })

  test('the fit decision is the server admission arithmetic: estimate and planCapacity agree', () => {
    const memories = ['512m', '768m', '1g', '2g']
    const isolations = ['shared', 'protected'] as const
    const populations = [0, 1, 4, 7, 20]
    const reserveds = [
      { reservedMemoryBytes: 0, reservedCpus: 0 },
      { reservedMemoryBytes: 3 * GiB, reservedCpus: 4 },
    ]
    for (const memory of memories) {
      for (const isolation of isolations) {
        for (const population of populations) {
          for (const reserved of reserveds) {
            const p = plan({ population, maxContainers: 4, memory, isolation })
            const estimate = setupEstimate(p, { ...capacity, ...reserved })
            const groups = population > 0 ? Math.min(4, population) : 0
            const perContainer = parseMemoryLimit(memory) + (isolation === 'protected' ? GATEWAY_MEMORY_BYTES : 0)
            const label = perContainer % 1024 ** 3 === 0 ? `${perContainer / 1024 ** 3}g` : `${Math.ceil(perContainer / 1024 ** 2)}m`
            const verdict = planCapacity(
              { containers: groups, memory: label, cpus: 1 + (isolation === 'protected' ? GATEWAY_CPUS : 0) },
              { totalMemoryBytes: capacity.totalMemoryBytes, usedMemoryBytes: capacity.usedMemoryBytes, cpus: capacity.cpus },
              { memoryBytes: reserved.reservedMemoryBytes, cpus: reserved.reservedCpus, observedBytes: 0 },
            )
            expect(estimate.fit.state === 'fits').toBe(verdict.ok)
          }
        }
      }
    }
  })
})
